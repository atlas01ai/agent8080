# Operational Runbook — Agent8080

## Quick Reference

| Component | Status Check | Restart | Logs |
|-----------|--------------|---------|------|
| **Base Daily Digest** | `cat data/digest-health.json` | `npm run digest` | `logs/digest.log` |
| **Alerts Service** | `npm run status` | `npm start` | `logs/alerts-service.log` |
| **Database** | `ls -la data/alerts.db` | Auto | N/A |
| **GitHub Pages** | Check https://atlas01ai.github.io/agent8080 | Auto on push | GitHub Actions |

---

## Daily Operations

### 1. Digest Health Check (9:00 AM PT)

```bash
# Check if digest was generated today
curl -s https://atlas01ai.github.io/agent8080/digests/base-digest-$(date +%Y-%m-%d).md | head -5

# If missing, generate manually
cd services && node base-daily-digest.mjs
```

**Expected Result:** Markdown file with today's date exists and is non-empty.

**Failure Action:**
1. Check `logs/digest.log` for errors
2. Verify Alchemy API key in `.env`
3. Check disk space: `df -h`
4. Manual generation if needed

### 2. Alerts Service Health (Every 4 hours)

```bash
# Check service status
npm run status

# Expected output
# {
#   "status": "healthy",
#   "last_block": 44745000,
#   "pending_alerts": 0,
#   "discord_connected": true
# }
```

**Failure Action:**
1. Check logs: `npm run logs | tail -50`
2. Verify Discord token: `cat .env | grep DISCORD`
3. Restart: `npm start`
4. Check database: `npm run migrate -- status`

### 3. Database Maintenance (Weekly)

```bash
# Check database size
ls -lh data/alerts.db

# If > 100MB, consider archiving
# Backup current
cp data/alerts.db data/alerts-$(date +%Y%m%d).db.bak

# Vacuum (compact)
sqlite3 data/alerts.db "VACUUM;"
```

---

## Common Issues

### Issue: Digest Not Generated

**Symptoms:** No file in `digests/` for today

**Diagnosis:**
```bash
# Check cron status
openclaw cron list | grep digest

# Check logs
tail -100 logs/digest.log
```

**Resolution:**
1. Resource limits → Increase or optimize script
2. Alchemy API failure → Check API key, verify Alchemy status
3. Git push failure → Check git auth, repository access

### Issue: Discord Alerts Not Sending

**Symptoms:** Users report no alerts, Discord status shows disconnected

**Diagnosis:**
```bash
# Check Discord token
node -e "console.log(process.env.DISCORD_BOT_TOKEN ? 'Set' : 'Missing')"

# Test Discord connection
node -e "const { Client } = require('discord.js'); const c = new Client({ intents: [] }); c.login(process.env.DISCORD_BOT_TOKEN).then(() => console.log('OK')).catch(e => console.log(e.message));"
```

**Resolution:**
1. Token expired → Regenerate at discord.com/developers
2. Intents missing → Enable Server Members + Message Content
3. Rate limited → Wait, implement backoff
4. Blocked by Discord → Check TOS compliance

### Issue: Database Locked

**Symptoms:** SQLite error "database is locked"

**Diagnosis:**
```bash
# Check processes
lsof data/alerts.db

# Check WAL files
ls -la data/*.db*
```

**Resolution:**
1. Kill stale processes
2. Check for WAL mode: `sqlite3 data/alerts.db "PRAGMA journal_mode;"`
3. If WAL files stuck: `sqlite3 data/alerts.db "PRAGMA wal_checkpoint(TRUNCATE);"`

---

## Deployment Procedures

### Staging Deployment

```bash
cd alerts-service

# 1. Run tests
npm test

# 2. Check all pass
# Expected: ✓ 30 tests passed

# 3. Deploy to staging
npm run deploy:staging

# 4. Verify
# Check staging URL
# Run smoke tests
```

### Production Deployment

```bash
cd alerts-service

# 1. Full test suite
npm test

# 2. Security audit
npm audit

# 3. Database backup
cp data/alerts.db data/alerts-$(date +%Y%m%d).db.bak

# 4. Deploy
npm run deploy:production

# 5. Health check
npm run status
# Verify all green

# 6. Monitor
# Watch logs for 30 minutes
npm run logs | grep -E "(ERROR|WARN|health)"
```

---

## Disaster Recovery

### Scenario: Complete Data Loss

**Recovery Steps:**
1. Clone repo: `git clone https://github.com/atlas01ai/agent8080.git`
2. Restore from backup: `cp backups/alerts-YYYYMMDD.db.bak data/alerts.db`
3. Install: `npm install`
4. Migrate: `npm run migrate`
5. Start: `npm start`
6. Verify: `npm run status`

**RTO:** 15 minutes  
**RPO:** 24 hours (daily backups)

### Scenario: Discord Bot Compromised

**Recovery Steps:**
1. Revoke token immediately: Discord Developer Portal
2. Generate new token
3. Update `.env`: `DISCORD_BOT_TOKEN=new_token`
4. Restart: `npm start`
5. Verify: Test DM to test user

**Notification:** Post to users: "Discord service restored after security rotation"

---

## Monitoring Dashboard

### Key Metrics

| Metric | Target | Alert At | Critical At |
|--------|--------|----------|-------------|
| Digest generation | 100% | < 95% | < 90% |
| Alert delivery rate | > 99% | < 95% | < 90% |
| Discord connection | Always | Downtime > 5 min | Downtime > 30 min |
| Database size | < 100MB | > 500MB | > 1GB |
| RPC latency | < 500ms | > 1s | > 3s |
| Error rate | < 1% | > 5% | > 10% |

### Automated Checks

```bash
# Health check script
echo "{
  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",
  \"digest_today\": $(test -f digests/base-digest-$(date +%Y-%m-%d).md && echo "true" || echo "false"),
  \"db_size_mb\": $(du -m data/alerts.db 2>/dev/null | cut -f1 || echo "0"),
  \"service_healthy\": $(pgrep -f "node src/index.js" > /dev/null && echo "true" || echo "false")
}" > data/health.json
```

---

## Escalation Procedures

| Issue | First Response | Escalation | Emergency |
|-------|---------------|------------|-----------|
| Digest missed | Generate manually | Investigate cron | 3+ days missed |
| Discord down | Check token | GitHub fallback only | > 6 hours down |
| Database corruption | Restore backup | Rebuild from logs | Data loss |
| Security incident | Revoke tokens | Full audit | Legal involvement |

**Emergency Contacts:**
- Primary: Discord DM to Richard
- Secondary: richykong@gmail.com
- On-chain: agent8080.base.eth

---

**Last Updated:** 2026-04-16  
**Owner:** agent8080  
**Review Cycle:** Monthly
