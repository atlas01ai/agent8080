/**
 * DiscordNotifier — Reliable Discord DM delivery for whale alerts.
 *
 * Features:
 *   • Persistent queue via pending_alerts table (survives restarts)
 *   • Per-user rate limiting (5 messages per 5 seconds per user)
 *   • Global rate limiting (50 per second across all channels)
 *   • Exponential backoff for 429 errors (1s, 2s, 4s, 8s... max 60s)
 *   • Circuit breaker (pauses if error rate > 10%)
 *   • Handles user blocks (403 → disables alerts for subscriber)
 *   • Graceful shutdown with pending alert persistence
 *
 * Integration:
 *   - Consumes 'whale_alert' events from WhaleDetector
 *   - Writes to pending_alerts queue for reliability
 *   - Sends DMs via discord.js with full rate limit compliance
 */

import { Client, GatewayIntentBits, Partials, DMChannel } from 'discord.js';
import { ethers } from 'ethers';
import { EventEmitter } from 'events';
import { getDb, logEvent } from '../db/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** DM rate limit: 5 messages per 5 seconds per user */
const DM_RATE_LIMIT_WINDOW_MS = 5000;
const DM_RATE_LIMIT_MAX_PER_WINDOW = 5;

/** Global rate limit: 50 per second across all channels */
const GLOBAL_RATE_LIMIT_WINDOW_MS = 1000;
const GLOBAL_RATE_LIMIT_MAX_PER_WINDOW = 50;

/** Exponential backoff configuration */
const BACKOFF_INITIAL_MS = 1000;
const BACKOFF_MULTIPLIER = 2;
const BACKOFF_MAX_MS = 60000;
const BACKOFF_JITTER_MS = 250; // Random jitter to prevent thundering herd

/** Circuit breaker configuration */
const CIRCUIT_BREAKER_ERROR_THRESHOLD = 0.10; // 10% error rate
const CIRCUIT_BREAKER_MIN_SAMPLE_SIZE = 10; // Minimum requests before calculating error rate
const CIRCUIT_BREAKER_COOLDOWN_MS = 30000; // 30 seconds before attempting reset
const CIRCUIT_BREAKER_MAX_FAILURES = 5; // Consecutive failures to open circuit

/** Queue processing configuration */
const QUEUE_PROCESS_INTERVAL_MS = 250; // Check queue every 250ms
const QUEUE_BATCH_SIZE = 10;
const QUEUE_MAX_DEPTH = 1000;
const MAX_RETRY_ATTEMPTS = 3;

/** Discord API error codes */
const DISCORD_ERROR_RATE_LIMITED = 429;
const DISCORD_ERROR_FORBIDDEN = 403;
const DISCORD_ERROR_NOT_FOUND = 404;

// ---------------------------------------------------------------------------
// DiscordNotifier
// ---------------------------------------------------------------------------

export class DiscordNotifier extends EventEmitter {
  /**
   * @param {object} config - Configuration object
   * @param {object} db - Database instance (better-sqlite3)
   */
  constructor(config, db) {
    super();

    this.config = config;
    this.db = db || getDb();

    // Discord client
    this.client = null;
    this.isReady = false;

    // Queue processing
    this.queueInterval = null;
    this.isProcessing = false;

    // Per-user rate limit tracking: Map<userId, { timestamps: number[], backoffUntil: number }>
    this.userRateLimits = new Map();

    // Global rate limit tracking: { timestamps: number[] }
    this.globalRateLimit = {
      timestamps: [],
      backoffUntil: 0,
    };

    // Circuit breaker state
    this.circuitBreaker = {
      state: 'CLOSED', // CLOSED, OPEN, HALF_OPEN
      failures: 0,
      successes: 0,
      totalRequests: 0,
      lastErrorTime: 0,
      openedAt: 0,
    };

    // Metrics for monitoring
    this.metrics = {
      sent: 0,
      failed: 0,
      queued: 0,
      rateLimited: 0,
      blocked: 0,
      circuitBreakerOpens: 0,
    };

    // Bind methods
    this.processQueue = this.processQueue.bind(this);
    this.handleWhaleAlert = this.handleWhaleAlert.bind(this);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * Initialize Discord client and start queue processing.
   */
  async start() {
    if (this.client) {
      throw new Error('DiscordNotifier already started');
    }

    const token = this.config.discord?.botToken;
    if (!token) {
      throw new Error('DISCORD_BOT_TOKEN not configured');
    }

    // Initialize Discord client with DM intents
    this.client = new Client({
      intents: [
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.Guilds,
      ],
      partials: [Partials.Channel, Partials.Message],
    });

    // Set up event handlers
    this.client.once('ready', () => {
      this.isReady = true;
      console.log(`Discord bot ready: ${this.client.user.tag}`);
      logEvent('discord_ready', {
        tag: this.client.user.tag,
        id: this.client.user.id,
      }, 'info');
    });

    this.client.on('error', (error) => {
      console.error('Discord client error:', error.message);
      logEvent('discord_client_error', { error: error.message }, 'error');
      this._recordFailure();
    });

    this.client.on('disconnect', () => {
      this.isReady = false;
      console.warn('Discord client disconnected');
      logEvent('discord_disconnect', {}, 'warning');
    });

    // Login to Discord
    await this.client.login(token);

    // Start queue processing loop
    this._startQueueProcessor();

    // Resume any pending alerts from previous session
    this._resumePendingAlerts();

    console.log('DiscordNotifier started successfully');
    logEvent('discord_notifier_started', {}, 'info');
  }

  /**
   * Graceful shutdown: stop processing and close Discord connection.
   */
  async stop() {
    console.log('DiscordNotifier stopping...');

    // Stop queue processing
    this._stopQueueProcessor();

    // Close Discord connection
    if (this.client) {
      this.client.destroy();
      this.client = null;
      this.isReady = false;
    }

    // Clear rate limit tracking
    this.userRateLimits.clear();
    this.globalRateLimit.timestamps = [];

    console.log('DiscordNotifier stopped');
    logEvent('discord_notifier_stopped', this.metrics, 'info');
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Queue an alert for delivery via Discord DM.
   * Writes to pending_alerts table for persistence.
   *
   * @param {object} alertData - Whale alert event data
   * @param {number} alertData.subscriberId
   * @param {string} alertData.discordId
   * @param {string} alertData.txHash
   * @param {number} alertData.blockNumber
   * @param {string} alertData.fromAddress
   * @param {string} alertData.toAddress
   * @param {string} alertData.valueEth
   * @param {string} alertData.alertType
   * @param {string} alertData.matchReason
   */
  queueAlert(alertData) {
    if (!alertData.subscriberId || !alertData.discordId) {
      console.warn('Cannot queue alert: missing subscriberId or discordId', alertData);
      return;
    }

    // Serialize alert data to JSON
    const alertJson = JSON.stringify(alertData);

    // Insert into pending_alerts table
    const stmt = this.db.prepare(`
      INSERT INTO pending_alerts 
      (subscriber_id, alert_type, alert_data, priority, attempts, max_attempts, next_attempt_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    try {
      const priority = this._calculatePriority(alertData);
      stmt.run(
        alertData.subscriberId,
        alertData.alertType || 'whale',
        alertJson,
        priority,
        0,
        MAX_RETRY_ATTEMPTS,
        Date.now() // Available immediately
      );

      this.metrics.queued++;

      // Trim queue if it exceeds max depth (remove oldest low-priority)
      this._trimQueueIfNeeded();

      console.log(`Queued alert for subscriber ${alertData.subscriberId}: ${alertData.txHash.slice(0, 10)}...`);
    } catch (err) {
      console.error('Failed to queue alert:', err.message);
      logEvent('queue_alert_failed', { error: err.message, alertData }, 'error');
    }
  }

  /**
   * Process pending alerts from the queue.
   * Called by the queue processing loop and can be triggered manually.
   */
  async processQueue() {
    if (this.isProcessing || !this.isReady) return;

    // Check circuit breaker
    if (!this._checkCircuitBreaker()) {
      return;
    }

    this.isProcessing = true;

    try {
      // Fetch pending alerts ready for processing
      const pendingAlerts = this._getPendingAlerts();

      for (const alert of pendingAlerts) {
        await this._processSingleAlert(alert);
      }
    } catch (err) {
      console.error('Queue processing error:', err.message);
      logEvent('queue_processing_error', { error: err.message }, 'error');
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Handle rate limit from Discord API response.
   *
   * @param {string} userId - Discord user ID
   * @param {number} retryAfter - Retry-After header value in seconds
   */
  handleRateLimit(userId, retryAfter) {
    const backoffMs = Math.min(
      (retryAfter * 1000) || this._calculateBackoff(userId),
      BACKOFF_MAX_MS
    );

    // Update user rate limit tracking
    const userLimit = this._getUserRateLimit(userId);
    userLimit.backoffUntil = Date.now() + backoffMs;

    // Also update global rate limit if it's a global rate limit
    this.globalRateLimit.backoffUntil = Math.max(
      this.globalRateLimit.backoffUntil,
      Date.now() + backoffMs
    );

    this.metrics.rateLimited++;

    console.warn(`Rate limited for user ${userId}, backing off for ${backoffMs}ms`);
    logEvent('discord_rate_limited', { userId, retryAfter, backoffMs }, 'warning');
  }

  /**
   * Mark a subscriber as blocked (e.g., after 403 error).
   * Disables alerts for that subscriber.
   *
   * @param {number} subscriberId - Internal subscriber ID
   */
  markSubscriberBlocked(subscriberId) {
    try {
      // Update subscriber record to disable alerts
      const stmt = this.db.prepare(`
        UPDATE subscribers 
        SET discord_id = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      stmt.run(subscriberId);

      // Delete pending alerts for this subscriber
      const deleteStmt = this.db.prepare(`
        DELETE FROM pending_alerts 
        WHERE subscriber_id = ? AND delivered_at IS NULL
      `);
      const result = deleteStmt.run(subscriberId);

      this.metrics.blocked++;

      console.warn(`Subscriber ${subscriberId} blocked Discord DMs, disabled alerts (${result.changes} pending alerts removed)`);
      logEvent('subscriber_blocked', { subscriberId, alertsRemoved: result.changes }, 'warning');
    } catch (err) {
      console.error('Failed to mark subscriber as blocked:', err.message);
      logEvent('mark_blocked_failed', { subscriberId, error: err.message }, 'error');
    }
  }

  /**
   * Get current status and metrics.
   */
  getStatus() {
    return {
      isReady: this.isReady,
      circuitBreaker: { ...this.circuitBreaker },
      metrics: { ...this.metrics },
      queueDepth: this._getQueueDepth(),
      globalBackoff: Math.max(0, this.globalRateLimit.backoffUntil - Date.now()),
    };
  }

  // ── Internal: Queue Management ──────────────────────────────────────────────

  _startQueueProcessor() {
    if (this.queueInterval) return;
    this.queueInterval = setInterval(this.processQueue, QUEUE_PROCESS_INTERVAL_MS);
  }

  _stopQueueProcessor() {
    if (this.queueInterval) {
      clearInterval(this.queueInterval);
      this.queueInterval = null;
    }
  }

  _getPendingAlerts() {
    const now = Date.now();

    const stmt = this.db.prepare(`
      SELECT 
        pa.*,
        s.discord_id,
        s.tier,
        s.alert_count_today,
        (SELECT COUNT(*) FROM whale_alerts WHERE subscriber_id = pa.subscriber_id AND date(created_at) = date('now')) as alerts_today_count
      FROM pending_alerts pa
      JOIN subscribers s ON pa.subscriber_id = s.id
      WHERE pa.delivered_at IS NULL
        AND pa.attempts < pa.max_attempts
        AND (pa.next_attempt_at IS NULL OR pa.next_attempt_at <= ?)
      ORDER BY pa.priority ASC, pa.created_at ASC
      LIMIT ?
    `);

    return stmt.all(now, QUEUE_BATCH_SIZE);
  }

  _getQueueDepth() {
    const stmt = this.db.prepare(`
      SELECT COUNT(*) as count FROM pending_alerts 
      WHERE delivered_at IS NULL AND attempts < max_attempts
    `);
    return stmt.get().count;
  }

  _trimQueueIfNeeded() {
    const depth = this._getQueueDepth();
    if (depth <= QUEUE_MAX_DEPTH) return;

    // Remove oldest low-priority alerts
    const toRemove = depth - QUEUE_MAX_DEPTH;
    const stmt = this.db.prepare(`
      DELETE FROM pending_alerts 
      WHERE id IN (
        SELECT id FROM pending_alerts 
        WHERE delivered_at IS NULL 
        ORDER BY priority DESC, created_at DESC 
        LIMIT ?
      )
    `);
    const result = stmt.run(toRemove);

    console.warn(`Queue depth exceeded ${QUEUE_MAX_DEPTH}, removed ${result.changes} oldest low-priority alerts`);
    logEvent('queue_trimmed', { removed: result.changes, depth }, 'warning');
  }

  _resumePendingAlerts() {
    // Reset alerts that were in-flight during a previous shutdown
    // by clearing next_attempt_at so they become immediately available
    const stmt = this.db.prepare(`
      UPDATE pending_alerts 
      SET next_attempt_at = NULL, attempts = 0
      WHERE delivered_at IS NULL 
        AND attempts > 0 
        AND next_attempt_at > ?
    `);
    const result = stmt.run(Date.now() + 60000); // Only reset if scheduled > 1 min in future

    if (result.changes > 0) {
      console.log(`Resumed ${result.changes} pending alerts from previous session`);
      logEvent('pending_alerts_resumed', { count: result.changes }, 'info');
    }
  }

  // ── Internal: Alert Processing ────────────────────────────────────────────

  async _processSingleAlert(alert) {
    const { id, subscriber_id, discord_id, alert_data, attempts, alerts_today_count } = alert;

    // Skip if no discord_id (user disconnected or blocked)
    if (!discord_id) {
      this._markAlertFailed(id, 'No Discord ID associated with subscriber');
      return;
    }

    // Check per-user rate limit
    if (!this._checkUserRateLimit(discord_id)) {
      this._rescheduleAlert(id, attempts, 'Per-user rate limit');
      return;
    }

    // Check global rate limit
    if (!this._checkGlobalRateLimit()) {
      this._rescheduleAlert(id, attempts, 'Global rate limit');
      return;
    }

    // Parse alert data
    let alertData;
    try {
      alertData = JSON.parse(alert_data);
    } catch (err) {
      this._markAlertFailed(id, `Invalid alert data JSON: ${err.message}`);
      return;
    }

    // Build message
    const message = this._buildMessage(alertData, alerts_today_count || 0);

    // Send the DM
    try {
      const messageId = await this._sendDM(discord_id, message);

      // Success! Mark as delivered
      this._markAlertDelivered(id, messageId);
      this._recordSuccess();

      // Update daily alert count in subscribers table for quick access
      this._incrementAlertCount(subscriber_id);

      console.log(`Delivered alert ${id} to subscriber ${subscriber_id}`);
    } catch (err) {
      await this._handleSendError(err, id, subscriber_id, discord_id, attempts);
    }
  }

  async _sendDM(userId, message) {
    try {
      const user = await this.client.users.fetch(userId);
      const dm = await user.send(message);
      return dm.id;
    } catch (err) {
      throw err;
    }
  }

  async _handleSendError(err, alertId, subscriberId, discordId, attempts) {
    const errorCode = err.code || err.statusCode || 0;
    const errorMessage = err.message || 'Unknown error';

    // Handle specific Discord error codes
    if (errorCode === DISCORD_ERROR_RATE_LIMITED || errorMessage.includes('rate limit')) {
      // Extract Retry-After from error
      const retryAfter = err.retryAfter || this._calculateBackoff(discordId);
      this.handleRateLimit(discordId, retryAfter);
      this._rescheduleAlert(alertId, attempts, `Rate limited: ${errorMessage}`, retryAfter * 1000);
      this._recordFailure();
      return;
    }

    if (errorCode === DISCORD_ERROR_FORBIDDEN) {
      // User blocked DMs or bot was removed
      this.markSubscriberBlocked(subscriberId);
      this._markAlertFailed(alertId, `Forbidden (403): ${errorMessage}`);
      this._recordFailure();
      return;
    }

    if (errorCode === DISCORD_ERROR_NOT_FOUND) {
      // User not found
      this.markSubscriberBlocked(subscriberId);
      this._markAlertFailed(alertId, `User not found (404): ${errorMessage}`);
      this._recordFailure();
      return;
    }

    // Network or other errors - retry with backoff
    const backoffMs = this._calculateBackoff(discordId);
    this._rescheduleAlert(alertId, attempts, `Send error: ${errorMessage}`, backoffMs);
    this._recordFailure();
  }

  // ── Internal: Database Operations ───────────────────────────────────────────

  _markAlertDelivered(alertId, discordMessageId) {
    const stmt = this.db.prepare(`
      UPDATE pending_alerts 
      SET delivered_at = CURRENT_TIMESTAMP, discord_message_id = ?
      WHERE id = ?
    `);
    stmt.run(discordMessageId, alertId);
    this.metrics.sent++;
  }

  _markAlertFailed(alertId, errorMessage) {
    const stmt = this.db.prepare(`
      UPDATE pending_alerts 
      SET error_log = ?, attempts = max_attempts
      WHERE id = ?
    `);
    stmt.run(errorMessage, alertId);
    this.metrics.failed++;
  }

  _rescheduleAlert(alertId, currentAttempts, errorMessage, customBackoffMs) {
    const backoffMs = customBackoffMs || this._calculateBackoff(alertId);
    const nextAttempt = Date.now() + backoffMs;

    const stmt = this.db.prepare(`
      UPDATE pending_alerts 
      SET attempts = attempts + 1, 
          next_attempt_at = ?,
          error_log = ?
      WHERE id = ?
    `);
    stmt.run(nextAttempt, errorMessage, alertId);
  }

  _incrementAlertCount(subscriberId) {
    try {
      const stmt = this.db.prepare(`
        UPDATE subscribers 
        SET alert_count_today = alert_count_today + 1
        WHERE id = ?
      `);
      stmt.run(subscriberId);
    } catch (err) {
      // Non-fatal, just log
      console.warn('Failed to increment alert count:', err.message);
    }
  }

  // ── Internal: Rate Limiting ────────────────────────────────────────────────

  _getUserRateLimit(userId) {
    if (!this.userRateLimits.has(userId)) {
      this.userRateLimits.set(userId, {
        timestamps: [],
        backoffUntil: 0,
        consecutiveFailures: 0,
      });
    }
    return this.userRateLimits.get(userId);
  }

  _checkUserRateLimit(userId) {
    const limit = this._getUserRateLimit(userId);
    const now = Date.now();

    // Check if in backoff period
    if (now < limit.backoffUntil) {
      return false;
    }

    // Clean old timestamps outside the window
    const windowStart = now - DM_RATE_LIMIT_WINDOW_MS;
    limit.timestamps = limit.timestamps.filter(ts => ts > windowStart);

    // Check if under limit
    if (limit.timestamps.length >= DM_RATE_LIMIT_MAX_PER_WINDOW) {
      return false;
    }

    // Record this send attempt
    limit.timestamps.push(now);
    return true;
  }

  _checkGlobalRateLimit() {
    const now = Date.now();

    // Check if in global backoff
    if (now < this.globalRateLimit.backoffUntil) {
      return false;
    }

    // Clean old timestamps
    const windowStart = now - GLOBAL_RATE_LIMIT_WINDOW_MS;
    this.globalRateLimit.timestamps = this.globalRateLimit.timestamps.filter(ts => ts > windowStart);

    // Check if under limit
    if (this.globalRateLimit.timestamps.length >= GLOBAL_RATE_LIMIT_MAX_PER_WINDOW) {
      return false;
    }

    // Record this send attempt
    this.globalRateLimit.timestamps.push(now);
    return true;
  }

  _calculateBackoff(key) {
    // Use per-user failure count for exponential backoff
    let failureCount = 0;
    if (key && this.userRateLimits.has(key)) {
      failureCount = this.userRateLimits.get(key).consecutiveFailures || 0;
    }

    // Calculate: initial * 2^failures + jitter
    const baseBackoff = BACKOFF_INITIAL_MS * Math.pow(BACKOFF_MULTIPLIER, Math.min(failureCount, 6));
    const jitter = Math.floor(Math.random() * BACKOFF_JITTER_MS);

    return Math.min(baseBackoff + jitter, BACKOFF_MAX_MS);
  }

  // ── Internal: Circuit Breaker ─────────────────────────────────────────────

  _checkCircuitBreaker() {
    const cb = this.circuitBreaker;
    const now = Date.now();

    switch (cb.state) {
      case 'OPEN':
        // Check if cooldown period has elapsed
        if (now - cb.openedAt >= CIRCUIT_BREAKER_COOLDOWN_MS) {
          cb.state = 'HALF_OPEN';
          cb.failures = 0;
          cb.successes = 0;
          console.log('Circuit breaker entering HALF_OPEN state');
          logEvent('circuit_breaker_half_open', {}, 'info');
        } else {
          return false;
        }
        break;

      case 'HALF_OPEN':
        // Allow limited traffic, will transition based on results
        break;

      case 'CLOSED':
      default:
        // Normal operation
        break;
    }

    return true;
  }

  _recordSuccess() {
    const cb = this.circuitBreaker;
    cb.successes++;
    cb.totalRequests++;

    if (cb.state === 'HALF_OPEN') {
      // After some successes in half-open, close the circuit
      if (cb.successes >= 3) {
        cb.state = 'CLOSED';
        cb.failures = 0;
        console.log('Circuit breaker CLOSED (healthy)');
        logEvent('circuit_breaker_closed', {}, 'info');
      }
    }

    // Reset consecutive failures for rate limiting
    if (cb.totalRequests % 10 === 0) {
      // Periodically clean up old rate limit entries
      this._cleanupRateLimits();
    }
  }

  _recordFailure() {
    const cb = this.circuitBreaker;
    cb.failures++;
    cb.totalRequests++;
    cb.lastErrorTime = Date.now();

    // Check if we should open the circuit
    if (cb.state === 'HALF_OPEN') {
      // Any failure in half-open goes back to open
      this._openCircuit();
      return;
    }

    if (cb.state === 'CLOSED') {
      // Calculate error rate
      if (cb.totalRequests >= CIRCUIT_BREAKER_MIN_SAMPLE_SIZE) {
        const errorRate = cb.failures / cb.totalRequests;
        if (errorRate >= CIRCUIT_BREAKER_ERROR_THRESHOLD || cb.failures >= CIRCUIT_BREAKER_MAX_FAILURES) {
          this._openCircuit();
        }
      } else if (cb.failures >= CIRCUIT_BREAKER_MAX_FAILURES) {
        // Open circuit after consecutive failures even with small sample
        this._openCircuit();
      }
    }
  }

  _openCircuit() {
    const cb = this.circuitBreaker;
    cb.state = 'OPEN';
    cb.openedAt = Date.now();
    cb.failures = 0;
    cb.successes = 0;
    cb.totalRequests = 0;
    this.metrics.circuitBreakerOpens++;

    console.error(`Circuit breaker OPENED (error rate > ${CIRCUIT_BREAKER_ERROR_THRESHOLD * 100}%)`);
    logEvent('circuit_breaker_opened', {
      threshold: CIRCUIT_BREAKER_ERROR_THRESHOLD,
      cooldownMs: CIRCUIT_BREAKER_COOLDOWN_MS,
    }, 'error');
  }

  _cleanupRateLimits() {
    const now = Date.now();
    const cutoff = now - (5 * 60 * 1000); // 5 minutes

    for (const [userId, limit] of this.userRateLimits.entries()) {
      // Remove users with no recent activity
      const lastActivity = Math.max(...limit.timestamps, limit.backoffUntil);
      if (lastActivity < cutoff) {
        this.userRateLimits.delete(userId);
      }
    }
  }

  // ── Internal: Message Building ──────────────────────────────────────────────

  _buildMessage(alertData, countToday) {
    const {
      valueEth,
      fromAddress,
      toAddress,
      txHash,
      blockNumber,
      alertType,
      matchReason,
    } = alertData;

    // Format addresses (show first 6 and last 4 chars)
    const formatAddr = (addr) => {
      if (!addr) return 'Unknown';
      const clean = addr.toLowerCase();
      return `${clean.slice(0, 6)}...${clean.slice(-4)}`;
    };

    // Get labels if available
    const fromLabel = alertData.fromLabel || 'External';
    const toLabel = alertData.toLabel || 'External';

    // Format timestamp
    const timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);

    // Build message
    let message = `🐋 Whale Alert — Base L2\n\n`;
    message += `**Amount:** ${parseFloat(valueEth).toFixed(4)} ETH\n`;
    message += `**From:** ${formatAddr(fromAddress)} (${fromLabel})\n`;
    message += `**To:** ${formatAddr(toAddress)} (${toLabel})\n`;
    message += `**Time:** ${timestamp} UTC\n`;
    message += `**Block:** ${blockNumber}\n`;
    message += `**Tx:** https://basescan.org/tx/${txHash}\n\n`;
    message += `**Match:** ${matchReason}\n`;
    message += `**Alerts today:** ${countToday}/5\n\n`;
    message += `⚠️ **NOT FINANCIAL ADVICE**\n`;
    message += `This is data-only, not investment advice.\n`;
    message += `*agent8080.base.eth* — autonomous experiment\n\n`;
    message += `Reply **STOP** to unsubscribe`;

    return message;
  }

  _calculatePriority(alertData) {
    // Priority 1 = urgent (paid tier), 5 = normal, 10 = low
    if (alertData.tier === 'paid' || alertData.tier === 'admin') {
      return 2;
    }
    if (parseFloat(alertData.valueEth) > 100) {
      return 3; // Large whales get higher priority
    }
    return 5;
  }

  // ── Event Handlers ─────────────────────────────────────────────────────────

  /**
   * Event handler for WhaleDetector 'whale_alert' events.
   * Can be passed directly to detector.on('whale_alert', ...)
   */
  handleWhaleAlert(alert) {
    this.queueAlert(alert);
  }
}

// ---------------------------------------------------------------------------
// Factory function for easy instantiation
// ---------------------------------------------------------------------------

export function createDiscordNotifier(config, db) {
  return new DiscordNotifier(config, db);
}

export default DiscordNotifier;
