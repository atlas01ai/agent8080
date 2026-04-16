# Council Advisor 2: Day 1 + Day 2 Integration Validation Report

**Date:** 2026-04-15  
**Scope:** BaseBlockPoller (Day 1) + WhaleDetector (Day 2) Integration  
**Status:** ✅ GO for Day 3 with Minor Gaps Addressed

---

## Executive Summary

The Day 1 (`BaseBlockPoller`) and Day 2 (`WhaleDetector`) components are **architecturally compatible** and can be integrated via EventEmitter events. The database schema supports both components' operations. However, there are **4 minor integration gaps** and **1 critical missing piece** (main entry point) that should be addressed before production deployment.

---

## 1. Component Connection Analysis

### 1.1 Event Flow: Poller → Detector

| Aspect | Status | Details |
|--------|--------|---------|
| Connection Method | ✅ OK | EventEmitter pattern (`poller.on('confirmed_block', ...)`)
| Event Name | ✅ OK | `confirmed_block` emitted by `BaseBlockPoller._pollOnce()`
| Event Handler | ✅ OK | `WhaleDetector.processBlock(blockData)` accepts the event payload |
| Data Format | ✅ OK | `{ blockNumber, blockHash, parentHash, transactions }` |

**Integration Code Pattern:**
```javascript
import { BaseBlockPoller } from './poller/BaseBlockPoller.js';
import { WhaleDetector } from './detector/WhaleDetector.js';

const poller = new BaseBlockPoller();
const detector = new WhaleDetector();

// Event wiring - this is the core integration point
poller.on('confirmed_block', (blockData) => detector.processBlock(blockData));

detector.on('whale_alert', (alert) => {
  // Future: Discord notifier will consume this
  console.log('Whale alert:', alert);
});

poller.start();
```

### 1.2 Database Handoff

| Component | DB Function | Schema Table | Status |
|-----------|-------------|--------------|--------|
| `BaseBlockPoller` | `recordBlockProcessed()` | `blocks_processed` | ✅ OK |
| `BaseBlockPoller` | `getLatestProcessedBlock()` | `blocks_processed` | ✅ OK |
| `BaseBlockPoller` | `markReorgDetected()` | `blocks_processed` | ✅ OK |
| `WhaleDetector` | `recordWhaleAlert()` | `whale_alerts` | ✅ OK |
| `WhaleDetector` | `getSubscriberAlertCountToday()` | `whale_alerts` | ✅ OK |
| `WhaleDetector` | `incrementSubscriberAlertCount()` | `subscribers` | ✅ OK |

---

## 2. System Startup Analysis

### 2.1 Startup Flow

```
┌─────────────────────────────────────────────────────────────┐
│ 1. npm install                                              │
│    └─ Dependencies: ethers, better-sqlite3, discord.js      │
├─────────────────────────────────────────────────────────────┤
│ 2. Environment Check                                        │
│    ├─ ✅ .env.example exists (reference)                   │
│    ├─ ⚠️  .env required at runtime                         │
│    └─ Required vars: BASE_RPC_URL                           │
├─────────────────────────────────────────────────────────────┤
│ 3. npm run migrate                                          │
│    ├─ Creates data/ directory                              │
│    ├─ Runs src/db/migrate.js                               │
│    └─ Applies schema.sql (v1)                            │
├─────────────────────────────────────────────────────────────┤
│ 4. Main Process Start                                     │
│    ├─ ⚠️  MISSING: No src/index.js entry point             │
│    └─ Must wire poller → detector manually                 │
└─────────────────────────────────────────────────────────────┘
```

### 2.2 Missing .env Error Behavior

| Scenario | Current Behavior | Recommended |
|----------|-----------------|-------------|
| `BASE_RPC_URL` missing | ❌ Throws at config load time (`requireEnv`) | ✅ OK - fail fast |
| `DATABASE_PATH` missing | ✅ Defaults to `./data/alerts.db` | ✅ OK |
| `DISCORD_BOT_TOKEN` missing | ✅ Optional (empty string default) | ✅ OK for Day 1-2 |

### 2.3 Missing Database Error Behavior

| Scenario | Current Behavior | Recommended |
|----------|-----------------|-------------|
| DB directory doesn't exist | ⚠️ `better-sqlite3` auto-creates | ✅ OK |
| Schema not initialized | ⚠️ Tables created on first `npm run migrate` | ✅ OK |
| DB file locked (concurrent) | ❌ SQLite error | Add startup check |

---

## 3. Database Schema Compatibility

### 3.1 Poller → Schema Match

```sql
-- Schema: blocks_processed
CREATE TABLE blocks_processed (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain_id INTEGER DEFAULT 8453,          -- ✅ Used
    block_number INTEGER UNIQUE NOT NULL,     -- ✅ Used
    block_hash TEXT NOT NULL,                 -- ✅ Used
    parent_hash TEXT,                         -- ✅ Used
    processed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    reorg_detected BOOLEAN DEFAULT 0          -- ✅ Used
);
```

| Function | SQL Call | Status |
|----------|----------|--------|
| `recordBlockProcessed()` | `INSERT ... ON CONFLICT UPDATE` | ✅ OK |
| `getLatestProcessedBlock()` | `SELECT ... ORDER BY DESC LIMIT 1` | ✅ OK |
| `getBlockByNumber()` | `SELECT ... WHERE chain_id=? AND block_number=?` | ✅ OK |
| `markReorgDetected()` | `UPDATE ... SET reorg_detected=1` | ✅ OK |

### 3.2 Detector → Schema Match

```sql
-- Schema: whale_alerts
CREATE TABLE whale_alerts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id INTEGER NOT NULL,
    tx_hash TEXT NOT NULL,
    block_number INTEGER NOT NULL,            -- ✅ Written
    from_address TEXT NOT NULL,               -- ✅ Written
    to_address TEXT NOT NULL,                 -- ✅ Written
    value_eth TEXT NOT NULL,                  -- ✅ Written
    alert_type TEXT,                          -- ✅ Written (whale_transfer/large_swap/contract_deploy)
    matched_watchlist TEXT,                   -- ✅ Written
    discord_message_id TEXT,                  -- Future: Day 3
    delivered_at TIMESTAMP,                   -- Future: Day 3
    delivery_status TEXT DEFAULT 'pending',  -- Future: Day 3
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

| Function | SQL Call | Status |
|----------|----------|--------|
| `recordWhaleAlert()` | `INSERT ... (8 params)` | ✅ OK |
| `_alertAlreadySent()` | `SELECT 1 WHERE subscriber_id=? AND tx_hash=?` | ✅ OK |
| `getSubscriberAlertCountToday()` | `SELECT COUNT(*) WHERE date(created_at)=date('now')` | ✅ OK |
| `incrementSubscriberAlertCount()` | `UPDATE subscribers SET alert_count_today+1` | ✅ OK |

### 3.3 Missing Columns/Constraints

| Issue | Severity | Location | Recommendation |
|-------|----------|----------|----------------|
| No UNIQUE on `(subscriber_id, tx_hash)` | 🔶 LOW | `whale_alerts` | Code has `_alertAlreadySent()` guard |
| `ON CONFLICT` in `recordWhaleAlert()` | 🔶 LOW | `db/index.js` | Uses `DO NOTHING` - OK |
| No index on `(subscriber_id, tx_hash)` | 🔶 LOW | `whale_alerts` | Add for dedup query performance |

---

## 4. End-to-End Data Flow Test

### 4.1 Happy Path Trace

```
┌─────────────────────────────────────────────────────────────────────┐
│ NEW BLOCK ARRIVES (Base L2)                                        │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 1. BaseBlockPoller._tick()                                          │
│    ├─ Calls getBlockNumber() via RPC                                │
│    ├─ Fetches full block with transactions                        │
│    └─ Stores in this._pending Map                                   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 2. recordBlockProcessed()                                           │
│    └─ INSERT INTO blocks_processed                                  │
│       (chain_id, block_number, block_hash, parent_hash)             │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 3. After BLOCK_CONFIRMATIONS (5 blocks)                            │
│    └─ emit 'confirmed_block' with transactions array                │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│ 4. WhaleDetector.processBlock()                                     │
│    ├─ Loads subscriber profiles (cached 30s)                        │
│    ├─ Iterates transactions                                         │
│    ├─ Checks: value >= threshold OR watchlist match                 │
│    └─ For each match:                                               │
│       ├─ Check daily limit (free tier)                              │
│       ├─ Deduplicate via _alertAlreadySent()                        │
│       ├─ recordWhaleAlert() → INSERT                               │
│       ├─ incrementSubscriberAlertCount() → UPDATE                  │
│       └─ emit 'whale_alert'                                          │
└─────────────────────────────────────────────────────────────────────┘
```

### 4.2 Transaction Traceability

| Query | Purpose | SQL |
|-------|---------|-----|
| Block existence | Verify block was processed | `SELECT * FROM blocks_processed WHERE block_number=?` |
| Transaction alerts | Find all alerts for tx | `SELECT * FROM whale_alerts WHERE tx_hash=?` |
| Subscriber received | Verify alert delivery | `SELECT * FROM whale_alerts WHERE subscriber_id=? AND tx_hash=?` |
| Delivery status | Check if Discord notified | `SELECT delivery_status FROM whale_alerts WHERE id=?` |

---

## 5. Testing Strategy

### 5.1 Unit Tests Needed

```javascript
// tests/poller.test.js - What to mock:
const mockProvider = {
  getBlockNumber: () => Promise.resolve(100),
  getBlock: (num, prefetch) => Promise.resolve({
    number: num,
    hash: '0xabc...',
    parentHash: '0xdef...',
    prefetchedTransactions: []
  })
};

// tests/detector.test.js - What to mock:
const mockDb = {
  prepare: () => ({ all: () => [], get: () => null, run: () => ({}) })
};
const mockSubscriber = {
  subscriberId: 1,
  thresholdWei: ethers.parseEther('10'),
  walletAddresses: new Set()
};
```

| Component | Mock Target | Test Cases |
|-----------|-------------|------------|
| `BaseBlockPoller` | `getBlockNumber()`, `getBlockWithTxs()` | Poll loop, confirmations, reorg detection |
| `WhaleDetector` | `getDb()`, `ethers.Provider` | Threshold matching, watchlist matching, daily limits |
| Both | SQLite in-memory | Integration via events |

### 5.2 Integration Tests

**Option A: Mock RPC (Recommended for CI)**
```javascript
// Use hardcoded block data, mock ethers.Provider
// Fast, deterministic, no API keys needed
```

**Option B: Live RPC (Recommended for pre-deploy)**
```javascript
// Use actual Alchemy/Base RPC
// Tests real latency, actual block processing
// Requires BASE_RPC_URL env var
```

**Recommended Hybrid Approach:**
- CI/CD: Mock RPC (fast, no external deps)
- Pre-deploy: Live RPC on Base mainnet (verify against real data)
- Weekly: Spot-check with known whale transactions

### 5.3 Manual Testing Checklist

| Step | Command | Expected Result |
|------|---------|----------------|
| 1. Install | `npm install` | All deps installed |
| 2. Env setup | `cp .env.example .env && edit` | Config ready |
| 3. Migrate | `npm run migrate` | Schema v1 applied |
| 4. Start | `node src/services/startup.js` (needs creation) | Poller starts, shows resumed block |
| 5. Check DB | `sqlite3 data/alerts.db "SELECT * FROM blocks_processed ORDER BY block_number DESC LIMIT 5"` | Recent blocks logged |
| 6. Test alert | Insert test subscriber, trigger threshold | Whale alert recorded |
| 7. Reorg sim | Manually insert conflicting block hash | Reorg detected, blocks marked |

### 5.4 Deployment Smoke Tests

```bash
# After deployment, run these commands:

# 1. Health check
curl -s http://localhost:3000/health || echo "Health endpoint needed"

# 2. Process status
ps aux | grep "node.*alerts" | grep -v grep

# 3. DB connectivity
sqlite3 data/alerts.db "SELECT COUNT(*) FROM blocks_processed"

# 4. Log tail
tail -f logs/alerts.log | grep -E "(poller|whale|error)"

# 5. RPC connectivity
node -e "const {getBlockNumber} = require('./src/utils/rpc.js'); getBlockNumber().then(n => console.log('Block:', n))"
```

---

## 6. Integration Gaps

### 6.1 Critical Gap: Missing Main Entry Point

| Gap | Severity | Location | Fix |
|-----|----------|----------|-----|
| No `src/index.js` | 🔴 HIGH | `package.json` points to non-existent file | Create `src/index.js` or `src/services/startup.js` |

**Required Implementation:**
```javascript
// src/index.js (missing)
import { BaseBlockPoller } from './poller/BaseBlockPoller.js';
import { WhaleDetector } from './detector/WhaleDetector.js';
import { config } from './config/index.js';
import { logEvent } from './db/index.js';

console.log('🚀 Agent Claw Wallet Alerts Service starting...');

// Initialize components
const poller = new BaseBlockPoller();
const detector = new WhaleDetector();

// Wire events
poller.on('confirmed_block', (blockData) => {
  detector.processBlock(blockData);
});

detector.on('whale_alert', (alert) => {
  console.log(`🐋 Whale alert: ${alert.valueEth} ETH`);
  // Future: Discord notifier here
});

poller.on('error', (err) => {
  logEvent('poller_fatal', { error: err.message }, 'error');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  poller.stop();
  process.exit(0);
});

// Start
poller.start();
console.log('✅ Service running. Press Ctrl+C to stop.');
```

### 6.2 Minor Gaps

| Gap | Severity | Impact | Fix |
|-----|----------|--------|-----|
| `services/` directory empty | 🔶 LOW | No service orchestration | Create startup.js or index.js |
| `tests/` directory empty | 🔶 LOW | No automated testing | Add unit tests |
| No health check endpoint | 🔶 LOW | Hard to monitor | Add HTTP health endpoint |
| No log rotation | 🔶 LOW | Logs grow unbounded | Add winston/pino with rotation |
| `getSubscriberAlertCountToday()` counts all alerts | 🔶 LOW | May count same tx multiple times if different subscribers | Add filter by subscriber_id |

### 6.3 Schema Improvements (Day 3+)

```sql
-- Add for Day 3 Discord integration
ALTER TABLE whale_alerts ADD COLUMN notification_sent BOOLEAN DEFAULT 0;
ALTER TABLE whale_alerts ADD COLUMN notification_error TEXT;

-- Add for performance
CREATE INDEX idx_whale_alerts_dedup ON whale_alerts(subscriber_id, tx_hash);
```

---

## 7. GO/NO-GO Decision

### ✅ GO for Day 3

**Rationale:**
1. **Core integration works**: Poller → Detector event flow is sound
2. **Database compatibility**: All schema calls match table definitions
3. **Configuration complete**: All required env vars documented
4. **Missing entry point is trivial**: ~20 lines to create

### Required Before Day 3 Merge:

| Task | Effort | Owner |
|------|--------|-------|
| Create `src/index.js` | 15 min | Developer |
| Test end-to-end with `npm start` | 10 min | Developer |
| Verify DB writes with sample block | 10 min | Developer |

### Day 3 Recommendations:

1. **Create main entry point** (blocking)
2. **Add health check endpoint** for monitoring
3. **Implement Discord notifier** consuming `whale_alert` events
4. **Add unit tests** for `_matchForSubscriber()` logic
5. **Consider adding SQLite index** on `(subscriber_id, tx_hash)` for dedup query

---

## Appendix: Quick Reference

### File Structure
```
alerts-service/
├── src/
│   ├── poller/
│   │   └── BaseBlockPoller.js      ✅ Day 1 complete
│   ├── detector/
│   │   └── WhaleDetector.js         ✅ Day 2 complete
│   ├── db/
│   │   ├── schema.sql               ✅ Complete
│   │   ├── migrate.js               ✅ Complete
│   │   └── index.js                 ✅ Complete
│   ├── config/
│   │   └── index.js                 ✅ Complete
│   ├── utils/
│   │   └── rpc.js                   ✅ Complete
│   └── services/
│       └── (EMPTY - needs startup.js) 🔴 Gap
├── package.json                     ✅ Complete
├── .env.example                     ✅ Complete
└── tests/                           ⚠️ Empty
```

### Environment Variables

| Variable | Required | Default | Purpose |
|----------|----------|---------|---------|
| `BASE_RPC_URL` | ✅ Yes | - | Alchemy/Base RPC |
| `DATABASE_PATH` | ❌ No | `./data/alerts.db` | SQLite location |
| `POLL_INTERVAL_MS` | ❌ No | 2500 | Poll frequency |
| `BLOCK_CONFIRMATIONS` | ❌ No | 5 | Confirmation depth |
| `WHALE_THRESHOLD_ETH` | ❌ No | 10.0 | Whale threshold |
| `FREE_TIER_DAILY_LIMIT` | ❌ No | 5 | Free tier cap |

---

*Report generated by Council Advisor 2 (Integration & Test Plan)*
