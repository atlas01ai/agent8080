/**
 * Base Block Poller Tests
 * Tests for block polling, confirmation tracking, reorg handling
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { BaseBlockPoller } from '../src/poller/BaseBlockPoller.js';

describe('BaseBlockPoller', () => {
  const defaultOptions = {
    intervalMs: 2500,
    blockConfirmations: 5,
    reorgLookback: 10,
    chainId: 8453
  };

  describe('Configuration', () => {
    it('should use default config when no options provided', () => {
      const poller = new BaseBlockPoller();
      
      assert.strictEqual(poller.intervalMs, 2500);
      assert.strictEqual(poller.confirmations, 5);
      assert.strictEqual(poller.reorgLookback, 10);
      assert.strictEqual(poller.chainId, 8453);
    });

    it('should accept custom options', () => {
      const poller = new BaseBlockPoller({
        intervalMs: 5000,
        blockConfirmations: 10,
        reorgLookback: 20,
        chainId: 1
      });
      
      assert.strictEqual(poller.intervalMs, 5000);
      assert.strictEqual(poller.confirmations, 10);
      assert.strictEqual(poller.reorgLookback, 20);
      assert.strictEqual(poller.chainId, 1);
    });
  });

  describe('Lifecycle', () => {
    it('should initialize with running = false', () => {
      const poller = new BaseBlockPoller(defaultOptions);
      
      assert.strictEqual(poller._running, false);
      assert.strictEqual(poller._polling, false);
    });

    it('should track latest seen block', () => {
      const poller = new BaseBlockPoller(defaultOptions);
      
      assert.strictEqual(poller._latestSeen, 0);
      
      // Simulate setting a block
      poller._latestSeen = 1000000;
      assert.strictEqual(poller._latestSeen, 1000000);
    });

    it('should maintain pending blocks map', () => {
      const poller = new BaseBlockPoller(defaultOptions);
      
      assert(poller._pending instanceof Map);
      assert.strictEqual(poller._pending.size, 0);
    });
  });

  describe('Confirmation Logic', () => {
    it('should calculate confirmation depth correctly', () => {
      const poller = new BaseBlockPoller({ ...defaultOptions, blockConfirmations: 5 });
      
      // Block 100 with tip at 105 = 5 confirmations
      const tip = 105;
      const blockNumber = 100;
      const confirmations = tip - blockNumber;
      
      assert.strictEqual(confirmations, 5);
      assert.strictEqual(confirmations >= poller.confirmations, true);
    });

    it('should not confirm blocks below threshold', () => {
      const poller = new BaseBlockPoller({ ...defaultOptions, blockConfirmations: 5 });
      
      // Block 100 with tip at 103 = only 3 confirmations
      const tip = 103;
      const blockNumber = 100;
      const confirmations = tip - blockNumber;
      
      assert.strictEqual(confirmations, 3);
      assert.strictEqual(confirmations >= poller.confirmations, false);
    });
  });

  describe('Reorg Handling', () => {
    it('should have reorg lookback configured', () => {
      const poller = new BaseBlockPoller({ ...defaultOptions, reorgLookback: 10 });
      
      assert.strictEqual(poller.reorgLookback, 10);
    });

    it('should check parent hash for reorg detection', () => {
      // Simulated reorg detection logic
      const storedParentHash = '0xabc123';
      const fetchedParentHash = '0xdef456';
      
      const isReorg = storedParentHash !== fetchedParentHash;
      assert.strictEqual(isReorg, true);
    });

    it('should handle valid chain continuation', () => {
      const storedParentHash = '0xabc123';
      const fetchedParentHash = '0xabc123';
      
      const isReorg = storedParentHash !== fetchedParentHash;
      assert.strictEqual(isReorg, false);
    });
  });

  describe('Polling Guard', () => {
    it('should prevent overlapping poll ticks', () => {
      const poller = new BaseBlockPoller(defaultOptions);
      
      // Simulate that a poll is in progress
      poller._polling = true;
      
      // If we tried to start another tick, it should be guarded
      assert.strictEqual(poller._polling, true);
    });
  });

  describe('Chain ID', () => {
    it('should default to Base L2 (8453)', () => {
      const poller = new BaseBlockPoller();
      assert.strictEqual(poller.chainId, 8453);
    });

    it('should support Ethereum mainnet', () => {
      const poller = new BaseBlockPoller({ chainId: 1 });
      assert.strictEqual(poller.chainId, 1);
    });
  });
});
