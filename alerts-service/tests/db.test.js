/**
 * Database Tests
 * Tests for SQLite operations with better-sqlite3
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert';
import { getDb, closeDb, createSubscriber, getSubscriberByDiscordId, getSubscribersByTier, updateSubscriberTier, recordWhaleAlert } from '../src/db/index.js';

describe('Database', () => {
  before(() => {
    // Ensure database is initialized
    const db = getDb();
    assert(db, 'Database should be initialized');
  });

  after(() => {
    closeDb();
  });

  describe('Subscriber Operations', () => {
    it('should create a new subscriber', () => {
      const result = createSubscriber('test123', 'test@example.com', 'free');
      assert(result, 'Should return subscriber record');
      assert(result.id, 'Should have subscriber ID');
    });

    it('should retrieve subscriber by Discord ID', () => {
      // First create
      createSubscriber('test456', 'test2@example.com', 'paid');
      
      // Then retrieve
      const subscriber = getSubscriberByDiscordId('test456');
      assert(subscriber, 'Should find subscriber');
      assert.strictEqual(subscriber.discord_id, 'test456');
      assert.strictEqual(subscriber.tier, 'paid');
    });

    it('should return undefined for non-existent subscriber', () => {
      const subscriber = getSubscriberByDiscordId('nonexistent999');
      assert.strictEqual(subscriber, undefined);
    });

    it('should update subscriber tier', () => {
      const created = createSubscriber('test789', 'test3@example.com', 'free');
      updateSubscriberTier(created.id, 'paid');
      
      const updated = getSubscriberByDiscordId('test789');
      assert.strictEqual(updated.tier, 'paid');
    });

    it('should get subscribers by tier', () => {
      const freeSubscribers = getSubscribersByTier('free');
      assert(Array.isArray(freeSubscribers), 'Should return array');
    });
  });

  describe('Whale Alert Operations', () => {
    it('should record a whale alert', () => {
      const subscriber = createSubscriber('whaletest', 'whale@test.com', 'free');
      
      const alertData = {
        blockNumber: 44745000,
        fromAddress: '0x1111',
        toAddress: '0x2222',
        valueEth: '15.5',
        alertType: 'whale_transfer',
        matchedWatchlist: null
      };
      
      const result = recordWhaleAlert(subscriber.id, '0xabc123', alertData);
      
      assert(result, 'Should return result');
      assert.strictEqual(result.changes, 1, 'Should insert 1 row');
    });
  });

  describe('Database Connection', () => {
    it('should use WAL mode', () => {
      const db = getDb();
      const pragma = db.pragma('journal_mode');
      assert.strictEqual(pragma[0].journal_mode, 'wal');
    });

    it('should enforce foreign keys', () => {
      const db = getDb();
      const pragma = db.pragma('foreign_keys');
      assert.strictEqual(pragma[0].foreign_keys, 1);
    });
  });
});
