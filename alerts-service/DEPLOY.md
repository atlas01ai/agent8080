# Alerts Service — Staging Deployment Checklist

## Pre-Deployment
- [ ] Copy `.env.example` to `.env`
- [ ] Fill in `BASE_RPC_URL` (Alchemy free tier)
- [ ] Fill in `DISCORD_BOT_TOKEN`
- [ ] Verify Discord bot has DM permissions
- [ ] Review `WHALE_THRESHOLD_ETH` (default: 10 ETH)

## Deployment
```bash
cd projects/agent-claw-wallet/alerts-service
./scripts/deploy-staging.sh
```

## Post-Deployment Verification
- [ ] Check service status: `npm run status`
- [ ] Verify logs: `npm run logs`
- [ ] Check database: `sqlite3 data/alerts.db "SELECT * FROM subscribers LIMIT 5;"`
- [ ] Verify Discord bot is online
- [ ] Test with small ETH transfer to trigger whale alert

## Monitoring
- Health check file: `data/health.json` (updates every 30s)
- Log file: `logs/alerts-service.log`
- Database: `data/alerts.db`

## Rollback
```bash
# If using systemd
sudo systemctl stop alerts-service

# If using direct process
kill $(cat data/service.pid)
```