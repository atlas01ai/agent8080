/**
 * Configuration loader for Alerts Service.
 * Reads environment variables (via dotenv) and exports a validated config object.
 *
 * All callers should import `config` from this module rather than reading
 * process.env directly so that defaults and type coercions are centralised.
 */

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load .env from the project root (two levels up from src/config/)
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..', '..');

// dotenv.config() is a no-op if the variable is already set, so this is safe
// for production environments that inject env vars directly.
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config({ path: join(projectRoot, '.env') });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function optionalEnv(name, defaultValue) {
  return process.env[name] ?? defaultValue;
}

function positiveInt(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer, got: ${raw}`);
  }
  return n;
}

function positiveFloat(name, defaultValue) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return defaultValue;
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name} must be a positive number, got: ${raw}`);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Config object
// ---------------------------------------------------------------------------

export const config = {
  // ── RPC ──────────────────────────────────────────────────────────────────
  rpc: {
    /** Primary Alchemy endpoint for Base mainnet */
    primaryUrl: requireEnv('BASE_RPC_URL'),
    /** Public fallback — no API key required */
    fallbackUrl: optionalEnv('BASE_RPC_FALLBACK_URL', 'https://mainnet.base.org'),
    /** Chain ID for Base L2 */
    chainId: 8453,
  },

  // ── Polling ───────────────────────────────────────────────────────────────
  poller: {
    /** Milliseconds between block-number checks */
    intervalMs: positiveInt('POLL_INTERVAL_MS', 2500),
    /** Blocks to wait before a block is considered confirmed */
    blockConfirmations: positiveInt('BLOCK_CONFIRMATIONS', 5),
    /** How many blocks back to check for reorgs when a mismatch is detected */
    reorgLookback: positiveInt('REORG_LOOKBACK_BLOCKS', 10),
  },

  // ── Whale detection ───────────────────────────────────────────────────────
  whale: {
    /** Default minimum ETH value to flag as a whale transaction */
    thresholdEth: positiveFloat('WHALE_THRESHOLD_ETH', 10.0),
    /**
     * Optional comma-separated list of additional addresses to always watch
     * regardless of transaction value.
     * e.g. WHALE_WATCHLIST=0xabc...,0xdef...
     */
    watchlist: (optionalEnv('WHALE_WATCHLIST', ''))
      .split(',')
      .map(addr => addr.trim().toLowerCase())
      .filter(Boolean),
  },

  // ── Discord ───────────────────────────────────────────────────────────────
  discord: {
    botToken: optionalEnv('DISCORD_BOT_TOKEN', ''),
    alertChannelId: optionalEnv('DISCORD_ALERT_CHANNEL_ID', ''),
  },

  // ── Agent wallet ──────────────────────────────────────────────────────────
  agent: {
    /** Payment-receiving address */
    address: optionalEnv('AGENT8080_ADDRESS', '0x862c803FEf8C9B28b3c06D67dFc1522534168CeC').toLowerCase(),
  },

  // ── Subscriptions ─────────────────────────────────────────────────────────
  tiers: {
    freeDailyLimit: positiveInt('FREE_TIER_DAILY_LIMIT', 5),
    healthFactorThreshold: positiveFloat('HEALTH_FACTOR_ALERT_THRESHOLD', 1.1),
  },

  // ── Database ──────────────────────────────────────────────────────────────
  db: {
    path: optionalEnv('DATABASE_PATH', join(projectRoot, 'data', 'alerts.db')),
  },
};

export default config;
