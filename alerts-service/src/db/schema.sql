-- Agent Claw Wallet Alerts Service — Database Schema v1
-- Base L2 Whale Alerts + Aave Liquidation Monitoring

-- Enable foreign keys
PRAGMA foreign_keys = ON;

-- Subscribers table: Core user data
CREATE TABLE IF NOT EXISTS subscribers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    discord_id TEXT UNIQUE,
    discord_handle TEXT,  -- e.g., @username for Discord DM
    email TEXT UNIQUE,
    tier TEXT CHECK(tier IN ('free', 'paid', 'admin')) DEFAULT 'free',
    
    -- Payment tracking
    payment_tx_hash TEXT,
    payment_amount_eth TEXT,
    payment_confirmed_at TIMESTAMP,
    payment_block_number INTEGER,
    subscription_expires_at TIMESTAMP,
    
    -- Whale alert settings
    whale_threshold_eth REAL DEFAULT 10.0,
    alert_count_today INTEGER DEFAULT 0,
    alert_reset_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Index for tier lookups
CREATE INDEX IF NOT EXISTS idx_subscribers_tier ON subscribers(tier);
CREATE INDEX IF NOT EXISTS idx_subscribers_discord ON subscribers(discord_id);

-- Subscriber wallets: Addresses to monitor
CREATE TABLE IF NOT EXISTS subscriber_wallets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER NOT NULL,
    wallet_address TEXT NOT NULL,
    chain_id INTEGER DEFAULT 8453,  -- Base L2
    label TEXT,  -- e.g., "Hot Wallet", "Vault"
    
    -- Monitoring flags
    monitor_aave BOOLEAN DEFAULT 1,
    monitor_compound BOOLEAN DEFAULT 0,
    
    -- Alert thresholds
    alert_threshold_hf REAL DEFAULT 1.1,  -- Health factor alert threshold
    
    added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE,
    UNIQUE(wallet_address, chain_id)
);

CREATE INDEX IF NOT EXISTS idx_wallets_subscriber ON subscriber_wallets(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_wallets_address ON subscriber_wallets(wallet_address);

-- Payment history: All ETH payments received
CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tx_hash TEXT UNIQUE NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,  -- Should be agent8080 address
    amount_eth TEXT NOT NULL,
    amount_wei TEXT NOT NULL,
    
    -- Memo parsing
    email_in_memo TEXT,
    subscriber_id INTEGER,
    
    -- Confirmation tracking
    block_number INTEGER,
    confirmations INTEGER DEFAULT 0,
    confirmed_at TIMESTAMP,
    
    -- OFAC screening
    ofac_screened BOOLEAN DEFAULT 0,
    ofac_match BOOLEAN DEFAULT 0,
    
    -- Metadata
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_payments_tx ON payments(tx_hash);
CREATE INDEX IF NOT EXISTS idx_payments_subscriber ON payments(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_payments_confirmed ON payments(confirmed_at);

-- Whale alerts: Large transaction alerts sent
CREATE TABLE IF NOT EXISTS whale_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER NOT NULL,
    
    -- Transaction details
    tx_hash TEXT NOT NULL,
    block_number INTEGER NOT NULL,
    from_address TEXT NOT NULL,
    to_address TEXT NOT NULL,
    value_eth TEXT NOT NULL,
    
    -- Alert content
    alert_type TEXT CHECK(alert_type IN ('whale_transfer', 'large_swap', 'contract_deploy')),
    matched_watchlist TEXT,  -- Which watchlist entry matched
    
    -- Delivery tracking
    discord_message_id TEXT,
    delivered_at TIMESTAMP,
    delivery_status TEXT DEFAULT 'pending',
    
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (subscriber_id) REFERENCES subscribers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_alerts_subscriber ON whale_alerts(subscriber_id);
CREATE INDEX IF NOT EXISTS idx_alerts_tx ON whale_alerts(tx_hash);
-- Index for alert deduplication (performance)
CREATE INDEX IF NOT EXISTS idx_alerts_subscriber_tx ON whale_alerts(subscriber_id, tx_hash);

-- Aave positions: Health factor snapshots
CREATE TABLE IF NOT EXISTS aave_positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_id INTEGER NOT NULL,
    
    -- Position data
    total_collateral_eth TEXT,
    total_debt_eth TEXT,
    available_borrow_eth TEXT,
    current_ltv REAL,
    max_ltv REAL,
    liquidation_threshold REAL,
    health_factor TEXT,
    
    -- Alert status
    hf_below_threshold BOOLEAN DEFAULT 0,
    alert_sent_at TIMESTAMP,
    
    -- Snapshot metadata
    block_number INTEGER,
    snapshot_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    
    FOREIGN KEY (wallet_id) REFERENCES subscriber_wallets(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_positions_wallet ON aave_positions(wallet_id);
CREATE INDEX IF NOT EXISTS idx_positions_hf ON aave_positions(health_factor);
CREATE INDEX IF NOT EXISTS idx_positions_snapshot ON aave_positions(snapshot_at);

-- Block tracking: For reorg handling
CREATE TABLE IF NOT EXISTS blocks_processed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id INTEGER DEFAULT 8453,
    block_number INTEGER UNIQUE NOT NULL,
    block_hash TEXT NOT NULL,
    parent_hash TEXT,
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reorg_detected BOOLEAN DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_blocks_number ON blocks_processed(block_number);
CREATE INDEX IF NOT EXISTS idx_blocks_chain ON blocks_processed(chain_id, block_number);

-- System events: For debugging and audit trail
CREATE TABLE IF NOT EXISTS system_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    event_data TEXT,  -- JSON blob
    severity TEXT CHECK(severity IN ('debug', 'info', 'warning', 'error', 'critical')),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_events_type ON system_events(event_type);
CREATE INDEX IF NOT EXISTS idx_events_created ON system_events(created_at);

-- Schema version tracking
CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY,
    applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    description TEXT
);

-- Insert initial schema version
INSERT OR IGNORE INTO schema_version (version, description) 
VALUES (1, 'Initial schema: subscribers, wallets, payments, alerts, positions, blocks');

-- ============================================================
-- Schema v3: Pending Alerts Queue for Reliable Discord DM Delivery
-- ============================================================

-- Pending alerts queue for reliable delivery
CREATE TABLE IF NOT EXISTS pending_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL,
  alert_data TEXT NOT NULL, -- JSON blob
  priority INTEGER DEFAULT 5,
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  next_attempt_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP,
  discord_message_id TEXT,
  error_log TEXT
);

CREATE INDEX IF NOT EXISTS idx_pending_alerts_subscriber ON pending_alerts(subscriber_id, delivered_at);
CREATE INDEX IF NOT EXISTS idx_pending_alerts_next_attempt ON pending_alerts(next_attempt_at, attempts);
CREATE INDEX IF NOT EXISTS idx_pending_alerts_priority ON pending_alerts(priority, created_at);

-- Update schema version record for v3
INSERT OR IGNORE INTO schema_version (version, description) 
VALUES (3, 'Pending alerts queue for reliable Discord DM delivery');
