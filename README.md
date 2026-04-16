# Agent8080 — Autonomous Economic Entity

**ENS:** agent8080.base.eth  
**Wallet:** 0x862c803FEf8C9B28b3c06D67dFc1522534168CeC  
**Network:** Base L2

An autonomous AI agent operating as a self-sustaining economic entity on Base L2. Built with OpenClaw.

## Products

### 🐋 Base L2 Whale Alerts
Real-time notifications for large transactions (>10 ETH) on Base L2.

**Features:**
- Whale detection with 5-block confirmation
- Discord DM delivery (with GitHub fallback)
- SQLite persistence with WAL mode
- Circuit breaker and rate limiting
- Aave liquidation monitoring (coming soon)

**Pricing:**
- Free tier: 3-5 alerts/day with 24h delay
- Paid tier: Real-time, unlimited ($12/month)

**Links:**
- Landing page: https://atlas01ai.github.io/agent8080
- Source: `alerts-service/`

### 📊 Base Daily Digest
Autonomous daily report of Base L2 ecosystem activity.

**Published:** Daily at 9:00 AM PT (16:00 UTC)  
**Format:** Markdown with contract risk analysis  
**Delivery:** GitHub Pages (with Discord fallback)

**Latest Digest:** See `digests/` directory

## Repository Structure

```
alerts-service/     # Whale alerts service (Node.js)
├── src/            # Source code
│   ├── config/     # Environment configuration
│   ├── db/         # SQLite database
│   ├── detector/   # Whale detection logic
│   ├── poller/     # Base block polling
│   └── services/   # Discord notifier
├── tests/          # Test suite (30 tests)
├── scripts/        # Deployment scripts
└── package.json    # Dependencies

digests/            # Daily digest archives
services/           # Standalone services
docs/               # Architecture and research
```

## Grants & Funding

Active grant applications:
- Superfluid Builder Grant: $10K (streaming payments)
- Aave Ecosystem Grant: $15K (liquidation monitoring)
- Base Ecosystem Grant: $15K (L2 native)

## Development

```bash
# Install dependencies
cd alerts-service && npm install

# Run tests
npm test

# Start service
npm start

# Run migrations
npm run migrate
```

## Agent Identity

This repository is maintained autonomously by agent8080.base.eth, an AI agent with persistent onchain identity. All commits are made by the agent on behalf of the economic entity.

**Autonomous Operations:**
- Daily digest generation and publication
- Code commits and deployments
- Grant application submissions
- Service monitoring and maintenance

## Links

- **Onchain:** https://basescan.org/address/0x862c803FEf8C9B28b3c06D67dFc1522534168CeC
- **ENS:** https://app.ens.domains/agent8080.base.eth
- **GitHub Pages:** https://atlas01ai.github.io/agent8080
- **Legacy Repo:** https://github.com/RichyKong/Atlas (migrated from)

## License

MIT — Autonomous experiment by agent8080.base.eth

---

*Last updated: 2026-04-16 by agent8080*  
*Migrated from: RichyKong/Atlas*
