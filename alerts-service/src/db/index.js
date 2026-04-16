// Database utilities for Alerts Service
// Uses better-sqlite3 for synchronous, high-performance operations

import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DB_PATH = process.env.DATABASE_PATH || join(__dirname, '../../data/alerts.db');

// Singleton database instance
let db = null;

export function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// Subscriber operations
export function createSubscriber(discordId, email, tier = 'free') {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO subscribers (discord_id, email, tier)
    VALUES (?, ?, ?)
    ON CONFLICT(discord_id) DO UPDATE SET
      email = excluded.email,
      tier = excluded.tier,
      updated_at = CURRENT_TIMESTAMP
    RETURNING id
  `);
  return stmt.get(discordId, email, tier);
}

export function getSubscriberByDiscordId(discordId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM subscribers WHERE discord_id = ?');
  return stmt.get(discordId);
}

export function getSubscribersByTier(tier) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM subscribers WHERE tier = ?');
  return stmt.all(tier);
}

export function updateSubscriberTier(subscriberId, tier) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE subscribers 
    SET tier = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);
  return stmt.run(tier, subscriberId);
}

export function resetDailyAlertCounts() {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE subscribers 
    SET alert_count_today = 0, alert_reset_at = CURRENT_TIMESTAMP
    WHERE alert_reset_at < date('now')
  `);
  return stmt.run();
}

// Wallet operations
export function addWallet(subscriberId, walletAddress, chainId = 8453, options = {}) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO subscriber_wallets 
    (subscriber_id, wallet_address, chain_id, label, monitor_aave, alert_threshold_hf)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(wallet_address, chain_id) DO UPDATE SET
      subscriber_id = excluded.subscriber_id,
      label = excluded.label,
      monitor_aave = excluded.monitor_aave,
      alert_threshold_hf = excluded.alert_threshold_hf
  `);
  return stmt.run(
    subscriberId,
    walletAddress,
    chainId,
    options.label || null,
    options.monitorAave ?? 1,
    options.alertThresholdHf || 1.1
  );
}

export function getWalletsBySubscriber(subscriberId) {
  const db = getDb();
  const stmt = db.prepare('SELECT * FROM subscriber_wallets WHERE subscriber_id = ?');
  return stmt.all(subscriberId);
}

export function getAllMonitoredWallets() {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT sw.*, s.tier, s.discord_id
    FROM subscriber_wallets sw
    JOIN subscribers s ON sw.subscriber_id = s.id
    WHERE sw.monitor_aave = 1 OR sw.monitor_compound = 1
  `);
  return stmt.all();
}

// Payment operations
export function recordPayment(txHash, fromAddress, toAddress, amountEth, amountWei, options = {}) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO payments 
    (tx_hash, from_address, to_address, amount_eth, amount_wei, email_in_memo, 
     block_number, ofac_screened, ofac_match)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tx_hash) DO UPDATE SET
      email_in_memo = excluded.email_in_memo,
      block_number = excluded.block_number
    RETURNING id
  `);
  return stmt.get(
    txHash,
    fromAddress,
    toAddress,
    amountEth,
    amountWei,
    options.emailInMemo || null,
    options.blockNumber || null,
    options.ofacScreened || 0,
    options.ofacMatch || 0
  );
}

export function confirmPayment(txHash, confirmations, confirmedAt) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE payments 
    SET confirmations = ?, confirmed_at = ?
    WHERE tx_hash = ?
  `);
  return stmt.run(confirmations, confirmedAt, txHash);
}

export function linkPaymentToSubscriber(txHash, subscriberId) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE payments 
    SET subscriber_id = ?
    WHERE tx_hash = ?
  `);
  return stmt.run(subscriberId, txHash);
}

export function getUnconfirmedPayments(minConfirmations = 5) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM payments 
    WHERE confirmations < ? AND confirmed_at IS NULL
    ORDER BY block_number ASC
  `);
  return stmt.all(minConfirmations);
}

// Whale alert operations
export function recordWhaleAlert(subscriberId, txHash, alertData) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO whale_alerts 
    (subscriber_id, tx_hash, block_number, from_address, to_address, 
     value_eth, alert_type, matched_watchlist)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(subscriber_id, tx_hash) DO NOTHING
  `);
  return stmt.run(
    subscriberId,
    txHash,
    alertData.blockNumber,
    alertData.fromAddress,
    alertData.toAddress,
    alertData.valueEth,
    alertData.alertType,
    alertData.matchedWatchlist
  );
}

export function markAlertDelivered(alertId, discordMessageId) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE whale_alerts 
    SET discord_message_id = ?, delivered_at = CURRENT_TIMESTAMP, delivery_status = 'delivered'
    WHERE id = ?
  `);
  return stmt.run(discordMessageId, alertId);
}

export function getSubscriberAlertCountToday(subscriberId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT COUNT(*) as count FROM whale_alerts 
    WHERE subscriber_id = ? 
    AND date(created_at) = date('now')
  `);
  return stmt.get(subscriberId).count;
}

export function incrementSubscriberAlertCount(subscriberId) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE subscribers 
    SET alert_count_today = alert_count_today + 1
    WHERE id = ?
  `);
  return stmt.run(subscriberId);
}

// Aave position operations
export function savePositionSnapshot(walletId, positionData) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO aave_positions 
    (wallet_id, total_collateral_eth, total_debt_eth, available_borrow_eth,
     current_ltv, max_ltv, liquidation_threshold, health_factor, 
     hf_below_threshold, block_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return stmt.run(
    walletId,
    positionData.totalCollateralEth,
    positionData.totalDebtEth,
    positionData.availableBorrowEth,
    positionData.currentLtv,
    positionData.maxLtv,
    positionData.liquidationThreshold,
    positionData.healthFactor,
    positionData.hfBelowThreshold ? 1 : 0,
    positionData.blockNumber
  );
}

export function getLatestPositionSnapshot(walletId) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM aave_positions 
    WHERE wallet_id = ? 
    ORDER BY snapshot_at DESC 
    LIMIT 1
  `);
  return stmt.get(walletId);
}

export function getPositionHistory(walletId, limit = 100) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM aave_positions 
    WHERE wallet_id = ? 
    ORDER BY snapshot_at DESC 
    LIMIT ?
  `);
  return stmt.all(walletId, limit);
}

// Block tracking
export function recordBlockProcessed(chainId, blockNumber, blockHash, parentHash) {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO blocks_processed (chain_id, block_number, block_hash, parent_hash)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chain_id, block_number) DO UPDATE SET
      block_hash = excluded.block_hash,
      parent_hash = excluded.parent_hash,
      processed_at = CURRENT_TIMESTAMP
  `);
  return stmt.run(chainId, blockNumber, blockHash, parentHash);
}

export function getLatestProcessedBlock(chainId = 8453) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM blocks_processed 
    WHERE chain_id = ? 
    ORDER BY block_number DESC 
    LIMIT 1
  `);
  return stmt.get(chainId);
}

export function getBlockByNumber(chainId, blockNumber) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM blocks_processed 
    WHERE chain_id = ? AND block_number = ?
  `);
  return stmt.get(chainId, blockNumber);
}

export function markReorgDetected(chainId, blockNumber) {
  const db = getDb();
  const stmt = db.prepare(`
    UPDATE blocks_processed 
    SET reorg_detected = 1
    WHERE chain_id = ? AND block_number = ?
  `);
  return stmt.run(chainId, blockNumber);
}

// System events
export function logEvent(eventType, eventData, severity = 'info') {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO system_events (event_type, event_data, severity)
    VALUES (?, ?, ?)
  `);
  return stmt.run(eventType, JSON.stringify(eventData), severity);
}

export function getRecentEvents(eventType, limit = 100) {
  const db = getDb();
  const stmt = db.prepare(`
    SELECT * FROM system_events 
    WHERE event_type = ?
    ORDER BY created_at DESC 
    LIMIT ?
  `);
  return stmt.all(eventType, limit);
}
