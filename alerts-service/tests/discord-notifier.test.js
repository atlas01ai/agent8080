/**
 * Discord Notifier Tests
 * Tests for DM delivery, rate limiting, circuit breaker
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { DiscordNotifier } from '../src/services/discord-service.js';

describe('DiscordNotifier', () => {
  const mockConfig = {
    token: 'mock-token',
    alertChannelId: null
  };

  describe('Rate Limiting', () => {
    it('should enforce per-user rate limits', () => {
      const notifier = new DiscordNotifier(mockConfig);
      const userId = 'user123';
      
      // Simulate 5 rapid requests (at limit)
      for (let i = 0; i < 5; i++) {
        const allowed = notifier._checkUserRateLimit(userId);
        assert.strictEqual(allowed, true, `Request ${i + 1} should be allowed`);
      }
      
      // 6th request should be rate limited
      const blocked = notifier._checkUserRateLimit(userId);
      assert.strictEqual(blocked, false, '6th request should be rate limited');
    });

    it('should track rate limits separately per user', () => {
      const notifier = new DiscordNotifier(mockConfig);
      
      // Max out user1
      for (let i = 0; i < 5; i++) {
        notifier._checkUserRateLimit('user1');
      }
      
      // User2 should still have full quota
      const user2Allowed = notifier._checkUserRateLimit('user2');
      assert.strictEqual(user2Allowed, true, 'User2 should not be affected by user1 limits');
    });
  });

  describe('Circuit Breaker', () => {
    it('should start in closed state', () => {
      const notifier = new DiscordNotifier(mockConfig);
      assert.strictEqual(notifier._getCircuitState(), 'closed');
    });

    it('should track request success/failure', () => {
      const notifier = new DiscordNotifier(mockConfig);
      
      // Record some requests
      notifier._recordRequest(true);  // Success
      notifier._recordRequest(false); // Failure
      
      const stats = notifier._getCircuitStats();
      assert.strictEqual(stats.total, 2);
      assert.strictEqual(stats.failures, 1);
    });

    it('should calculate error rate correctly', () => {
      const notifier = new DiscordNotifier(mockConfig);
      
      // 1 failure out of 10 requests = 10%
      for (let i = 0; i < 9; i++) {
        notifier._recordRequest(true);
      }
      notifier._recordRequest(false);
      
      const rate = notifier._getErrorRate();
      assert.strictEqual(rate, 0.10);
    });
  });

  describe('Exponential Backoff', () => {
    it('should calculate correct backoff delays', () => {
      const notifier = new DiscordNotifier(mockConfig);
      
      // Attempt 1: 1000ms
      assert.strictEqual(notifier._calculateBackoff(1), 1000);
      
      // Attempt 2: 2000ms
      assert.strictEqual(notifier._calculateBackoff(2), 2000);
      
      // Attempt 3: 4000ms
      assert.strictEqual(notifier._calculateBackoff(3), 4000);
    });

    it('should cap backoff at maximum', () => {
      const notifier = new DiscordNotifier(mockConfig);
      
      // High attempt number should still return max (60000ms)
      const delay = notifier._calculateBackoff(100);
      assert(delay <= 60000, 'Backoff should be capped at 60 seconds');
    });
  });

  describe('Queue Management', () => {
    it('should respect queue maximum depth', () => {
      const notifier = new DiscordNotifier(mockConfig);
      
      // Check that QUEUE_MAX_DEPTH is configured
      assert(notifier.QUEUE_MAX_DEPTH > 0, 'Queue should have max depth');
    });
  });
});
