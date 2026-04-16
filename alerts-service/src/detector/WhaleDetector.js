/**
 * WhaleDetector — identifies whale transactions in confirmed blocks.
 *
 * A transaction is flagged as a whale if ANY of the following are true:
 *   1. The ETH value is >= the subscriber's personal threshold (default 10 ETH).
 *   2. The from or to address is on the global watchlist (WHALE_WATCHLIST env).
 *   3. The from or to address is in a subscriber's personal watchlist wallet table.
 *
 * For each matching transaction, the detector:
 *   - Deduplicates against whale_alerts (same tx_hash + subscriber_id).
 *   - Enforces daily alert limits for free-tier subscribers.
 *   - Writes a whale_alert row to the DB.
 *   - Emits a 'whale_alert' event that the Discord notifier consumes.
 *
 * Usage:
 *   const detector = new WhaleDetector();
 *   poller.on('confirmed_block', (blockData) => detector.processBlock(blockData));
 *   detector.on('whale_alert', (alert) => notifier.send(alert));
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { config } from '../config/index.js';
import {
  getDb,
  recordWhaleAlert,
  getSubscriberAlertCountToday,
  incrementSubscriberAlertCount,
  logEvent,
} from '../db/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** 10 ETH in wei (BigInt) — used for fast comparisons */
const DEFAULT_THRESHOLD_WEI = ethers.parseEther(String(config.whale.thresholdEth));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Load all active subscribers along with their custom thresholds and
 * monitored wallet addresses so we can match against each transaction.
 *
 * Returns a flat array so we iterate once per block rather than once per tx.
 *
 * @returns {{ subscriberId: number, discordId: string, tier: string, thresholdWei: bigint, walletAddresses: Set<string> }[]}
 */
function loadSubscriberProfiles() {
  const db = getDb();

  const subscribers = db.prepare(`
    SELECT id, discord_id, tier, whale_threshold_eth, alert_count_today,
           alert_reset_at, subscription_expires_at
    FROM subscribers
  `).all();

  const walletsBySubscriber = db.prepare(`
    SELECT subscriber_id, wallet_address
    FROM subscriber_wallets
    WHERE chain_id = ?
  `).all(config.rpc.chainId);

  // Build a map: subscriberId → Set<address>
  const walletMap = new Map();
  for (const { subscriber_id, wallet_address } of walletsBySubscriber) {
    if (!walletMap.has(subscriber_id)) {
      walletMap.set(subscriber_id, new Set());
    }
    walletMap.get(subscriber_id).add(wallet_address.toLowerCase());
  }

  return subscribers.map(s => ({
    subscriberId: s.id,
    discordId: s.discord_id,
    tier: s.tier,
    thresholdWei: ethers.parseEther(String(s.whale_threshold_eth ?? config.whale.thresholdEth)),
    walletAddresses: walletMap.get(s.id) ?? new Set(),
    alertCountToday: s.alert_count_today ?? 0,
    isPaid: s.tier === 'paid' || s.tier === 'admin',
    subscriptionExpiresAt: s.subscription_expires_at,
  }));
}

/**
 * Check if a paid subscriber's subscription is still active.
 *
 * @param {string|null} expiresAt - ISO timestamp or null
 * @returns {boolean}
 */
function subscriptionActive(expiresAt) {
  if (!expiresAt) return false;
  return new Date(expiresAt) > new Date();
}

// ---------------------------------------------------------------------------
// WhaleDetector
// ---------------------------------------------------------------------------

export class WhaleDetector extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {string[]} [options.watchlist]        - Additional watchlist addresses (lowercase)
   * @param {number}   [options.freeDailyLimit]   - Max alerts/day for free tier
   */
  constructor(options = {}) {
    super();

    /** Global watchlist addresses (lowercase) from config + constructor override */
    this._globalWatchlist = new Set([
      ...config.whale.watchlist,
      ...(options.watchlist ?? []).map(a => a.toLowerCase()),
    ]);

    this._freeDailyLimit = options.freeDailyLimit ?? config.tiers.freeDailyLimit;

    /** Cache subscriber profiles; refreshed each block */
    this._subscriberProfiles = [];
    this._lastProfileLoad = 0;

    /** Minimum ms between full subscriber reloads (avoid per-tx DB reads) */
    this._profileCacheTtlMs = 30_000;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Process a confirmed block from the poller.
   *
   * @param {{ blockNumber: number, blockHash: string, transactions: ethers.TransactionResponse[] }} blockData
   */
  async processBlock(blockData) {
    const { blockNumber, transactions } = blockData;

    if (!transactions || transactions.length === 0) return;

    // Refresh subscriber profiles if cache is stale
    this._maybeRefreshProfiles();

    let whalesFound = 0;

    for (const tx of transactions) {
      try {
        whalesFound += this._processTx(tx, blockNumber);
      } catch (err) {
        logEvent('whale_detector_tx_error', {
          txHash: tx.hash,
          error: err.message,
        }, 'error');
      }
    }

    if (whalesFound > 0) {
      logEvent('whale_block_processed', {
        blockNumber,
        txCount: transactions.length,
        whalesFound,
      }, 'info');
    }
  }

  /**
   * Add an address to the runtime global watchlist (does not persist to DB).
   *
   * @param {string} address
   */
  addToWatchlist(address) {
    this._globalWatchlist.add(address.toLowerCase());
  }

  /**
   * @returns {{ watchlistSize: number, subscriberCount: number }}
   */
  status() {
    return {
      watchlistSize: this._globalWatchlist.size,
      subscriberCount: this._subscriberProfiles.length,
    };
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _maybeRefreshProfiles() {
    const now = Date.now();
    if (now - this._lastProfileLoad > this._profileCacheTtlMs) {
      this._subscriberProfiles = loadSubscriberProfiles();
      this._lastProfileLoad = now;
    }
  }

  /**
   * Evaluate a single transaction against all subscribers.
   *
   * @param {ethers.TransactionResponse} tx
   * @param {number} blockNumber
   * @returns {number} Count of alerts generated
   */
  _processTx(tx, blockNumber) {
    // Skip transactions with no ETH value and not on watchlist
    const txValue = tx.value ?? 0n;
    const fromAddr = (tx.from ?? '').toLowerCase();
    const toAddr = (tx.to ?? '').toLowerCase();

    const isGlobalWatchlist =
      this._globalWatchlist.has(fromAddr) ||
      this._globalWatchlist.has(toAddr);

    // Quick exit: value below global default AND not on watchlist
    if (txValue < DEFAULT_THRESHOLD_WEI && !isGlobalWatchlist) {
      return 0;
    }

    let alertsGenerated = 0;

    for (const profile of this._subscriberProfiles) {
      const match = this._matchForSubscriber(tx, txValue, fromAddr, toAddr, profile, isGlobalWatchlist);
      if (!match) continue;

      // Daily limit check for free tier
      if (!profile.isPaid || !subscriptionActive(profile.subscriptionExpiresAt)) {
        const todayCount = getSubscriberAlertCountToday(profile.subscriberId);
        if (todayCount >= this._freeDailyLimit) continue;
      }

      const valueEth = ethers.formatEther(txValue);

      // Explicit dedup check (schema has no UNIQUE on (subscriber_id, tx_hash))
      if (this._alertAlreadySent(profile.subscriberId, tx.hash)) continue;

      // Write to DB
      recordWhaleAlert(profile.subscriberId, tx.hash, {
        blockNumber,
        fromAddress: tx.from,
        toAddress: tx.to,
        valueEth,
        alertType: this._classifyTx(tx),
        matchedWatchlist: match.reason,
      });

      incrementSubscriberAlertCount(profile.subscriberId);
      alertsGenerated++;

      /** @type {WhaleAlertEvent} */
      const event = {
        subscriberId: profile.subscriberId,
        discordId: profile.discordId,
        txHash: tx.hash,
        blockNumber,
        fromAddress: tx.from,
        toAddress: tx.to,
        valueEth,
        valueWei: txValue.toString(),
        alertType: this._classifyTx(tx),
        matchReason: match.reason,
      };

      this.emit('whale_alert', event);

      console.log(
        `[whale] ${valueEth} ETH — ${tx.hash.slice(0, 10)}… → sub ${profile.subscriberId} (${match.reason})`
      );
    }

    return alertsGenerated;
  }

  /**
   * Determine whether this tx should trigger an alert for the given subscriber.
   *
   * @returns {{ reason: string } | null}
   */
  _matchForSubscriber(tx, txValue, fromAddr, toAddr, profile, isGlobalWatchlist) {
    // 1. Global watchlist match (highest priority)
    if (isGlobalWatchlist) {
      const matched = this._globalWatchlist.has(fromAddr) ? fromAddr : toAddr;
      return { reason: `global_watchlist:${matched}` };
    }

    // 2. Subscriber's personal wallet watchlist
    if (profile.walletAddresses.size > 0) {
      if (profile.walletAddresses.has(fromAddr)) {
        return { reason: `subscriber_wallet:${fromAddr}` };
      }
      if (profile.walletAddresses.has(toAddr)) {
        return { reason: `subscriber_wallet:${toAddr}` };
      }
    }

    // 3. Value threshold
    if (txValue >= profile.thresholdWei) {
      return { reason: `threshold:${ethers.formatEther(profile.thresholdWei)}eth` };
    }

    return null;
  }

  /**
   * Check whether we've already alerted this subscriber about this tx.
   * Guards against the missing UNIQUE(subscriber_id, tx_hash) constraint.
   *
   * @param {number} subscriberId
   * @param {string} txHash
   * @returns {boolean}
   */
  _alertAlreadySent(subscriberId, txHash) {
    const db = getDb();
    const row = db.prepare(`
      SELECT 1 FROM whale_alerts
      WHERE subscriber_id = ? AND tx_hash = ?
      LIMIT 1
    `).get(subscriberId, txHash);
    return row != null;
  }

  /**
   * Classify a transaction type for the alert_type column.
   *
   * @param {ethers.TransactionResponse} tx
   * @returns {'whale_transfer' | 'large_swap' | 'contract_deploy'}
   */
  _classifyTx(tx) {
    if (!tx.to) return 'contract_deploy';
    // Heuristic: non-empty data suggests a contract interaction (swap/DeFi)
    if (tx.data && tx.data !== '0x' && tx.data.length > 10) return 'large_swap';
    return 'whale_transfer';
  }
}

/**
 * @typedef {Object} WhaleAlertEvent
 * @property {number} subscriberId
 * @property {string} discordId
 * @property {string} txHash
 * @property {number} blockNumber
 * @property {string} fromAddress
 * @property {string} toAddress
 * @property {string} valueEth
 * @property {string} valueWei
 * @property {'whale_transfer'|'large_swap'|'contract_deploy'} alertType
 * @property {string} matchReason
 */

export default WhaleDetector;
