/**
 * Configuration Tests
 * Validates environment configuration loading
 */

import { describe, it } from 'node:test';
import assert from 'node:assert';
import { config } from '../src/config/index.js';

describe('Config', () => {
  it('should load RPC configuration', () => {
    assert(config.rpc, 'RPC config should exist');
    assert(config.rpc.primaryUrl, 'Primary RPC URL should be configured');
    assert.strictEqual(config.rpc.chainId, 8453, 'Chain ID should be Base L2');
  });

  it('should load poller configuration', () => {
    assert(config.poller, 'Poller config should exist');
    assert(typeof config.poller.intervalMs === 'number');
    assert(typeof config.poller.blockConfirmations === 'number');
    assert(typeof config.poller.reorgLookback === 'number');
  });

  it('should load whale detection configuration', () => {
    assert(config.whale, 'Whale config should exist');
    assert(typeof config.whale.thresholdEth === 'number');
    assert(config.whale.thresholdEth > 0, 'Threshold should be positive');
    assert(Array.isArray(config.whale.watchlist), 'Watchlist should be array');
  });

  it('should load Discord configuration', () => {
    assert(config.discord, 'Discord config should exist');
    assert(typeof config.discord.botToken === 'string');
    assert(typeof config.discord.alertChannelId === 'string');
  });

  it('should load database configuration', () => {
    assert(config.db, 'DB config should exist');
    assert(typeof config.db.path === 'string');
  });

  it('should have agent address configured', () => {
    assert(config.agent, 'Agent config should exist');
    assert(config.agent.address, 'Agent address should be configured');
    assert(config.agent.address.startsWith('0x'), 'Address should be valid format');
  });

  it('should load subscription tiers', () => {
    assert(config.tiers, 'Tiers config should exist');
    assert(typeof config.tiers.freeDailyLimit === 'number');
    assert(typeof config.tiers.healthFactorThreshold === 'number');
  });
});
