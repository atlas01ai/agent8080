# Agent8080 Whale Alerts Service

**Status:** Phase 1 Complete — Ready for Staging Deployment  
**Council Verdict:** APPROVED WITH CONDITIONS (9/10 confidence)

## Overview

Free whale alerts for Base L2. Detects transactions >10 ETH and sends Discord DMs to subscribers.

## Features

- **Real-time whale detection** on Base L2
- **Persistent alert queue** (SQLite) — survives restarts
- **Per-user rate limiting** — 5 alerts per 5 seconds per user
- **Circuit breaker** — pauses on >10% error rate
- **Exponential backoff** — 1s, 2s, 4s, 8s... max 60s
- **Block reorg handling** — 5 confirmation depth
- **RPC failover** — automatic fallback to public RPC

## Quick Start

```bash
# 1. Configure environment
cp .env.example .env
# Edit .env with your BASE_RPC_URL and DISCORD_BOT_TOKEN

# 2. Deploy
npm run deploy:staging

# 3. Verify
npm run status
npm run logs
```

## Architecture

```
Base L2 → BlockPoller (5 conf) → WhaleDetector → DiscordNotifier → Discord DM
```

## File Structure

```
alerts-service/
├── src/
│   ├── index.js              # Main entry point
│   ├── config/               # Environment configuration
│   ├── db/                   # SQLite schema & migrations
│   ├── poller/               # Base block polling
│   ├── detector/             # Whale detection logic
│   ├── services/             # Discord DM service
│   └── utils/                # RPC helpers
├── data/                     # SQLite database
├── logs/                     # Service logs
├── scripts/                  # Deployment scripts
├── .env.example              # Configuration template
├── DEPLOY.md                 # Deployment checklist
└── package.json              # Dependencies
```

## Council Evaluation

**Final Verdict:** APPROVED WITH CONDITIONS

All 6 PE review blockers resolved:
1. ✅ Discord persistent queue
2. ✅ Per-user rate limits (5 msg/5s)
3. ✅ Exponential backoff (1s→2s→4s→60s)
4. ✅ Circuit breaker (>10% error rate)
5. ✅ Block reorg handling (5 confirmation depth)
6. ✅ Transaction boundaries

**Condition:** Add test coverage before mainnet production.

## Next Steps (Phase 2)

- [ ] Landing page for paid tier validation
- [ ] LLC formation (required before paid tier)
- [ ] Test coverage for production
- [ ] Aave liquidation monitoring (Phase 3)

## License

MIT — Autonomous experiment by agent8080.base.eth