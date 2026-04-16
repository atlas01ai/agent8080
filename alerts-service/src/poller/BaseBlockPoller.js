/**
 * BaseBlockPoller — polls Base L2 for new blocks at a configurable interval.
 *
 * Design:
 *   - Polls `getBlockNumber()` every POLL_INTERVAL_MS (default 2.5s).
 *   - Fetches full block data (with txs) for every unseen block.
 *   - Maintains a pending queue; blocks are only emitted as 'confirmed_block'
 *     once BLOCK_CONFIRMATIONS (default 5) deeper blocks have been seen.
 *   - Detects reorgs by comparing each incoming block's parentHash against
 *     the hash we stored for block N-1. On mismatch it walks back to find
 *     the common ancestor, marks affected DB rows, and re-queues the canonical
 *     chain from that point.
 *
 * Events emitted:
 *   'confirmed_block'  { block, transactions }  — ready for downstream processing
 *   'reorg'            { depth, fromBlock }      — reorg detected and handled
 *   'error'            Error                     — non-fatal RPC error
 */

import { EventEmitter } from 'events';
import { ethers } from 'ethers';
import { config } from '../config/index.js';
import {
  recordBlockProcessed,
  getLatestProcessedBlock,
  getBlockByNumber,
  markReorgDetected,
  logEvent,
} from '../db/index.js';
import { getBlockNumber, getBlockWithTxs } from '../utils/rpc.js';

// ---------------------------------------------------------------------------
// Types (JSDoc)
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PendingBlock
 * @property {number} number
 * @property {string} hash
 * @property {string} parentHash
 * @property {ethers.TransactionResponse[]} transactions
 */

// ---------------------------------------------------------------------------
// BaseBlockPoller
// ---------------------------------------------------------------------------

export class BaseBlockPoller extends EventEmitter {
  /**
   * @param {object} [options]
   * @param {number} [options.intervalMs]         - Poll interval in ms
   * @param {number} [options.blockConfirmations] - Confirmation depth
   * @param {number} [options.reorgLookback]      - Blocks to walk back on reorg
   * @param {number} [options.chainId]            - Chain ID
   */
  constructor(options = {}) {
    super();

    this.intervalMs = options.intervalMs ?? config.poller.intervalMs;
    this.confirmations = options.blockConfirmations ?? config.poller.blockConfirmations;
    this.reorgLookback = options.reorgLookback ?? config.poller.reorgLookback;
    this.chainId = options.chainId ?? config.rpc.chainId;

    /** @type {Map<number, PendingBlock>} */
    this._pending = new Map();

    /** Highest block number we've fetched and stored */
    this._latestSeen = 0;

    /** Whether the polling loop is running */
    this._running = false;

    /** Timer handle returned by setTimeout */
    this._timer = null;

    /** Guard against overlapping poll ticks */
    this._polling = false;
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Start the polling loop.  Picks up from the last processed block in the DB
   * so we don't re-process blocks after a restart.
   */
  async start() {
    if (this._running) return;
    this._running = true;

    // Resume from DB state so we don't re-alert on restart
    const latest = getLatestProcessedBlock(this.chainId);
    if (latest) {
      this._latestSeen = latest.block_number;
      console.log(`[poller] Resuming from block ${this._latestSeen}`);
      logEvent('poller_start', { resumedFrom: this._latestSeen }, 'info');
    } else {
      // First run — start from the current chain tip; don't back-fill history
      try {
        const tip = await getBlockNumber();
        this._latestSeen = tip;
        console.log(`[poller] First run — starting from chain tip ${tip}`);
        logEvent('poller_start', { startedAt: tip }, 'info');
      } catch (err) {
        console.error('[poller] Failed to get initial block number:', err.message);
        logEvent('poller_start_error', { error: err.message }, 'error');
      }
    }

    this._scheduleTick();
  }

  /**
   * Stop the polling loop gracefully.
   */
  stop() {
    this._running = false;
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    logEvent('poller_stop', { lastSeen: this._latestSeen }, 'info');
    console.log('[poller] Stopped');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _scheduleTick() {
    if (!this._running) return;
    this._timer = setTimeout(() => this._tick(), this.intervalMs);
  }

  async _tick() {
    if (!this._running) return;
    if (this._polling) {
      // Previous tick still in flight — skip and reschedule
      this._scheduleTick();
      return;
    }

    this._polling = true;
    try {
      await this._pollOnce();
    } catch (err) {
      // Non-fatal — emit error and keep running
      this.emit('error', err);
      logEvent('poller_tick_error', { error: err.message }, 'error');
    } finally {
      this._polling = false;
      this._scheduleTick();
    }
  }

  /**
   * Single poll cycle: fetch new blocks, detect reorgs, emit confirmations.
   */
  async _pollOnce() {
    const latestOnChain = await getBlockNumber();

    if (latestOnChain <= this._latestSeen) {
      // No new blocks
      return;
    }

    // Fetch all new blocks (gap can be >1 if we were down briefly)
    for (let num = this._latestSeen + 1; num <= latestOnChain; num++) {
      const block = await getBlockWithTxs(num);

      // ── Reorg detection ────────────────────────────────────────────────
      if (num > this._latestSeen + 1 || this._latestSeen > 0) {
        const reorgDetected = await this._checkReorg(block);
        if (reorgDetected) {
          // _handleReorg re-queues from the common ancestor; stop this loop
          // and let the next tick re-fetch the canonical chain.
          this._latestSeen = reorgDetected.reorgFrom - 1;
          break;
        }
      }

      // ── Store in pending queue ─────────────────────────────────────────
      /** @type {PendingBlock} */
      const pending = {
        number: block.number,
        hash: block.hash,
        parentHash: block.parentHash,
        transactions: block.prefetchedTransactions || [],
      };
      this._pending.set(block.number, pending);

      // Record in DB (for future reorg detection across restarts)
      recordBlockProcessed(this.chainId, block.number, block.hash, block.parentHash);

      this._latestSeen = block.number;
    }

    // ── Emit confirmed blocks ──────────────────────────────────────────────
    // A block is confirmed once `this._latestSeen - block.number >= this.confirmations`
    const confirmationCutoff = this._latestSeen - this.confirmations;
    const toConfirm = [...this._pending.entries()]
      .filter(([num]) => num <= confirmationCutoff)
      .sort(([a], [b]) => a - b);

    for (const [num, pending] of toConfirm) {
      this._pending.delete(num);
      this.emit('confirmed_block', {
        blockNumber: pending.number,
        blockHash: pending.hash,
        parentHash: pending.parentHash,
        transactions: pending.transactions,
      });
    }
  }

  /**
   * Check if the incoming block creates a reorg with our stored chain.
   *
   * @param {ethers.Block} block
   * @returns {Promise<{reorgFrom: number}|null>} - null if no reorg
   */
  async _checkReorg(block) {
    // Look up what we stored for block.number - 1
    const prevNum = block.number - 1;

    // First check our in-memory pending queue (fast path)
    const inMemory = this._pending.get(prevNum);
    if (inMemory) {
      if (inMemory.hash === block.parentHash) {
        return null; // All good
      }
      return this._handleReorg(block, prevNum, inMemory.hash);
    }

    // Fall back to DB
    const stored = getBlockByNumber(this.chainId, prevNum);
    if (!stored) {
      // We don't have block N-1 — can't confirm, but also can't flag reorg
      return null;
    }

    if (stored.block_hash === block.parentHash) {
      return null; // All good
    }

    return this._handleReorg(block, prevNum, stored.block_hash);
  }

  /**
   * Handle a detected reorg.  Walk back to find the common ancestor and
   * mark affected blocks.
   *
   * @param {ethers.Block} canonicalBlock - First block of the new canonical chain
   * @param {number}       mismatchAt    - Block number where the hash diverged
   * @param {string}       storedHash    - What we had stored for `mismatchAt`
   * @returns {Promise<{reorgFrom: number}>}
   */
  async _handleReorg(canonicalBlock, mismatchAt, storedHash) {
    console.warn(
      `[poller] Reorg detected at block ${mismatchAt}! ` +
      `stored=${storedHash.slice(0, 10)}… canonical parent=${canonicalBlock.parentHash.slice(0, 10)}…`
    );

    // Walk back up to REORG_LOOKBACK blocks to find common ancestor
    let depth = 0;
    let reorgFrom = mismatchAt;

    for (let i = 1; i <= this.reorgLookback; i++) {
      const checkNum = mismatchAt - i;
      if (checkNum < 0) break;

      const stored = getBlockByNumber(this.chainId, checkNum);
      if (!stored) break;

      // Fetch what the canonical chain says about this block
      let canonicalAtDepth;
      try {
        canonicalAtDepth = await getBlockWithTxs(checkNum);
      } catch {
        break;
      }

      if (stored.block_hash === canonicalAtDepth.hash) {
        // Found common ancestor
        reorgFrom = checkNum + 1;
        depth = i;
        break;
      }

      // This block is also reorged — mark it
      markReorgDetected(this.chainId, checkNum);
      this._pending.delete(checkNum);
    }

    // Mark the original mismatch point
    markReorgDetected(this.chainId, mismatchAt);
    this._pending.delete(mismatchAt);

    logEvent('reorg_detected', {
      depth,
      reorgFrom,
      mismatchAt,
      canonicalBlock: canonicalBlock.number,
      canonicalParent: canonicalBlock.parentHash,
      storedHash,
    }, 'warning');

    this.emit('reorg', { depth, fromBlock: reorgFrom });

    return { reorgFrom };
  }

  // ── Status ─────────────────────────────────────────────────────────────────

  /**
   * @returns {{ running: boolean, latestSeen: number, pendingCount: number }}
   */
  status() {
    return {
      running: this._running,
      latestSeen: this._latestSeen,
      pendingCount: this._pending.size,
    };
  }
}

export default BaseBlockPoller;
