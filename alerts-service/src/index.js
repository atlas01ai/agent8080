/**
 * Alerts Service — Main Entry Point
 * Wires together: Block Poller → Whale Detector → Discord Notifier
 *
 * Usage:
 *   npm start          # Start the service
 *   npm run dev        # Development mode with auto-reload
 *   npm run migrate    # Run database migrations
 *
 * Environment:
 *   Requires .env file with BASE_RPC_URL, DISCORD_BOT_TOKEN, etc.
 *   See .env.example for required variables.
 */

import { config } from './config/index.js';
import { getDb, closeDb, logEvent } from './db/index.js';
import { BaseBlockPoller } from './poller/BaseBlockPoller.js';
import { WhaleDetector } from './detector/WhaleDetector.js';
import { DiscordNotifier } from './services/discord-service.js';

// ---------------------------------------------------------------------------
// Graceful Shutdown
// ---------------------------------------------------------------------------

let poller = null;
let detector = null;
let discordNotifier = null;
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log('Shutdown already in progress...');
    return;
  }
  isShuttingDown = true;
  
  console.log(`\n${signal} received. Shutting down gracefully...`);

  // Stop polling
  if (poller) {
    poller.stop();
    console.log('Poller stopped');
  }

  // Stop Discord notifier (allow queue flush)
  if (discordNotifier) {
    try {
      await discordNotifier.stop();
      console.log('Discord notifier stopped');
    } catch (err) {
      console.error('Error stopping Discord notifier:', err.message);
    }
  }

  // Close database
  try {
    closeDb();
    console.log('Database connection closed');
  } catch (err) {
    console.error('Error closing database:', err.message);
  }

  // Log shutdown
  try {
    logEvent('system_shutdown', { signal }, 'info');
  } catch {
    // Ignore logging errors during shutdown
  }

  console.log('Shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// ---------------------------------------------------------------------------
// Health Check
// ---------------------------------------------------------------------------

function setupHealthCheck() {
  // Simple health endpoint for monitoring
  // In production, this could be an HTTP server or file-based check
  setInterval(() => {
    try {
      const db = getDb();
      db.prepare('SELECT 1').get(); // Ping database

      // Write health status to file
      const status = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        pollerRunning: poller?.isRunning ?? false,
        uptime: process.uptime(),
        discordConnected: discordNotifier?.isReady ?? false,
        pendingAlerts: discordNotifier?.getQueueDepth?.() ?? 0
      };

      import('fs').then(fs => {
        fs.writeFileSync(
          './data/health.json',
          JSON.stringify(status, null, 2)
        );
      }).catch(err => {
        console.error('Health check write failed:', err.message);
      });
    } catch (err) {
      console.error('Health check failed:', err.message);
      logEvent('health_check_failed', { error: err.message }, 'warning');
    }
  }, 30000); // Every 30 seconds
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('🚀 Starting Alerts Service...');
  console.log(`Environment: ${config.nodeEnv}`);
  console.log(`Database: ${config.database.path}`);
  console.log(`RPC Endpoint: ${config.rpc.primaryUrl.replace(/\/v2\/.*/, '/v2/***')}`); // Hide API key

  // Verify database connection
  try {
    const db = getDb();
    const version = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get();
    console.log(`Database schema version: ${version?.version ?? 'unknown'}`);
  } catch (err) {
    console.error('❌ Database not initialized. Run: npm run migrate');
    process.exit(1);
  }

  // Log startup
  logEvent('system_startup', {
    version: process.env.npm_package_version,
    nodeEnv: config.nodeEnv,
    chainId: config.chainId
  }, 'info');

  // Initialize components
  console.log('Initializing components...');

  // Initialize Discord notifier
  discordNotifier = new DiscordNotifier(config.discord, getDb());
  await discordNotifier.start();
  console.log('✅ Discord notifier started');

  // Create whale detector
  detector = new WhaleDetector();

  // Handle whale alerts — wire to Discord
  detector.on('whale_alert', async (alert) => {
    console.log('🐋 Whale Alert:', {
      tx: alert.txHash.slice(0, 20) + '...',
      value: alert.valueEth + ' ETH',
      subscriber: alert.subscriberId
    });

    // Queue for Discord delivery (best-effort)
    try {
      await discordNotifier.queueAlert(alert);
    } catch (err) {
      console.error('Failed to queue alert for Discord:', err.message);
      // Don't throw — delivery is best-effort
    }
  });

  detector.on('error', (err) => {
    console.error('WhaleDetector error:', err.message);
    logEvent('detector_error', { error: err.message }, 'error');
  });

  // Create block poller
  poller = new BaseBlockPoller();

  // Wire poller → detector
  poller.on('confirmed_block', (blockData) => {
    detector.processBlock(blockData).catch((err) => {
      console.error('Error processing block:', err.message);
    });
  });

  poller.on('reorg', (reorgInfo) => {
    console.warn('⚠️ Chain reorganization detected:', reorgInfo);
    logEvent('chain_reorg', reorgInfo, 'warning');
  });

  poller.on('error', (err) => {
    console.error('Poller error:', err.message);
    logEvent('poller_error', { error: err.message }, 'error');
  });

  // Setup health check
  setupHealthCheck();

  // Start polling
  console.log('Starting block poller...');
  poller.start();

  console.log('✅ Service running. Press Ctrl+C to stop.');
  console.log(`Polling every ${config.poller.intervalMs}ms with ${config.poller.blockConfirmations}-block confirmation`);
}

// Run main (handle errors)
main().catch((err) => {
  console.error('❌ Fatal error:', err);
  logEvent('fatal_error', { error: err.message, stack: err.stack }, 'critical');
  process.exit(1);
});
