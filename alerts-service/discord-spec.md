# Discord Service Implementation Specification

## Requirements

### Core Functionality
- Send whale alerts via Discord DM to subscribers
- Respect Discord rate limits (5 msg/5s per user)
- Implement persistent queue for reliability
- Handle failures gracefully with retry logic

### Database Schema Additions

```sql
-- Pending alerts queue for reliable delivery
CREATE TABLE pending_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  subscriber_id INTEGER REFERENCES subscribers(id) ON DELETE CASCADE,
  alert_type TEXT NOT NULL, -- 'whale', 'liquidation', etc.
  alert_data TEXT NOT NULL, -- JSON blob
  priority INTEGER DEFAULT 5, -- 1=urgent, 10=low
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER DEFAULT 3,
  next_attempt_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  delivered_at TIMESTAMP,
  discord_message_id TEXT,
  error_log TEXT
);

CREATE INDEX idx_pending_alerts_subscriber ON pending_alerts(subscriber_id, delivered_at);
CREATE INDEX idx_pending_alerts_next_attempt ON pending_alerts(next_attempt_at, attempts);
CREATE INDEX idx_pending_alerts_priority ON pending_alerts(priority, created_at);
```

### Discord Rate Limit Handling

**Rate Limits (from Discord docs):**
- DM: 5 messages per 5 seconds per user
- Global: 50 per second across all channels
- Burst handling: Queue with exponential backoff

**Implementation Strategy:**
- Per-user send queues
- Batch processing with rate limit respect
- Exponential backoff: 1s, 2s, 4s, 8s... max 60s
- Circuit breaker: pause sending if error rate > 10%

### Error Handling

| Error | Action |
|-------|--------|
| 429 (rate limited) | Respect Retry-After header, exponential backoff |
| 403 (blocked) | Mark subscriber as blocked, disable alerts |
| 404 (user not found) | Mark subscriber invalid |
| Network error | Retry with backoff |
| Queue full | Drop oldest low-priority alerts |

### Integration Points

**Incoming:** WhaleDetector emits 'whale_alert' event
**Outgoing:** Write to pending_alerts, process via queue

### Configuration

```javascript
{
  discord: {
    token: process.env.DISCORD_BOT_TOKEN,
    rateLimitMs: 1000, // per-user minimum delay
    maxQueueDepth: 1000,
    batchSize: 10,
    retryAttempts: 3,
    circuitBreakerThreshold: 0.1 // 10% error rate
  }
}
```

### Message Format

```
🐋 Whale Alert — Base L2

Amount: {valueEth} ETH (~${usdValue})
From: {fromAddress} ({label})
To: {toAddress} ({label})
Time: {timestamp} UTC
Block: {blockNumber}
Tx: https://basescan.org/tx/{txHash}

Match: {matchReason}
Alerts today: {countToday}/5

⚠️ NOT FINANCIAL ADVICE
This is data-only, not investment advice.
agent8080.base.eth — autonomous experiment

Reply STOP to unsubscribe
```
