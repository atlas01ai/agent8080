/**
 * RPC provider factory for Base L2.
 *
 * Strategy:
 *   1. Try primary provider (Alchemy). If it fails N consecutive times,
 *      switch to the fallback (public Base RPC).
 *   2. Once on fallback, attempt to recover primary every RECOVERY_INTERVAL_MS.
 *   3. Exposes a single `getProvider()` call so callers never deal with failover
 *      logic themselves.
 *
 * Alchemy free tier budget:
 *   300M CU/day.  getBlockNumber = 10 CU, getBlock (full) = 16 CU.
 *   Polling every 2.5s: 34,560 polls/day × 26 CU ≈ 898K CU/day — well within limits.
 */

import { ethers } from 'ethers';
import { config } from '../config/index.js';
import { logEvent } from '../db/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Switch to fallback after this many consecutive primary failures */
const PRIMARY_FAILURE_THRESHOLD = 3;

/** How often (ms) to try recovering the primary while on fallback */
const RECOVERY_INTERVAL_MS = 60_000;

/** Timeout (ms) for a single RPC call before we consider it failed */
const RPC_TIMEOUT_MS = 8_000;

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {ethers.JsonRpcProvider | null} */
let primaryProvider = null;

/** @type {ethers.JsonRpcProvider | null} */
let fallbackProvider = null;

/** @type {'primary' | 'fallback'} */
let activeProvider = 'primary';

let consecutivePrimaryFailures = 0;
let recoveryTimer = null;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Wrap an ethers provider call with a hard timeout.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {number} [timeoutMs]
 * @returns {Promise<T>}
 */
function withTimeout(promise, timeoutMs = RPC_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`RPC call timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

/**
 * Create (or return cached) primary provider.
 * @returns {ethers.JsonRpcProvider}
 */
function getPrimaryProvider() {
  if (!primaryProvider) {
    primaryProvider = new ethers.JsonRpcProvider(config.rpc.primaryUrl, config.rpc.chainId, {
      staticNetwork: true,  // skip eth_chainId on every call
    });
  }
  return primaryProvider;
}

/**
 * Create (or return cached) fallback provider.
 * @returns {ethers.JsonRpcProvider}
 */
function getFallbackProvider() {
  if (!fallbackProvider) {
    fallbackProvider = new ethers.JsonRpcProvider(config.rpc.fallbackUrl, config.rpc.chainId, {
      staticNetwork: true,
    });
  }
  return fallbackProvider;
}

/**
 * Try to probe the primary provider and switch back if healthy.
 */
async function attemptPrimaryRecovery() {
  try {
    const p = getPrimaryProvider();
    await withTimeout(p.getBlockNumber(), 5_000);
    // Success — switch back
    activeProvider = 'primary';
    consecutivePrimaryFailures = 0;
    clearInterval(recoveryTimer);
    recoveryTimer = null;
    logEvent('rpc_recovery', { url: config.rpc.primaryUrl }, 'info');
    console.log('[rpc] Primary provider recovered — switching back');
  } catch {
    // Still down, keep retrying
  }
}

/**
 * Record a primary failure and switch to fallback if threshold reached.
 * @param {Error} err
 */
function handlePrimaryFailure(err) {
  consecutivePrimaryFailures++;
  if (
    consecutivePrimaryFailures >= PRIMARY_FAILURE_THRESHOLD &&
    activeProvider === 'primary'
  ) {
    activeProvider = 'fallback';
    logEvent('rpc_failover', {
      reason: err.message,
      fallbackUrl: config.rpc.fallbackUrl,
    }, 'warning');
    console.warn('[rpc] Switching to fallback provider after primary failures:', err.message);

    if (!recoveryTimer) {
      recoveryTimer = setInterval(attemptPrimaryRecovery, RECOVERY_INTERVAL_MS);
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Returns the currently active ethers.js JsonRpcProvider.
 * Callers should re-invoke this on each use rather than caching the result,
 * since the active provider may switch during failover.
 *
 * @returns {ethers.JsonRpcProvider}
 */
export function getProvider() {
  return activeProvider === 'primary' ? getPrimaryProvider() : getFallbackProvider();
}

/**
 * Fetch the latest block number, with automatic failover.
 *
 * @returns {Promise<number>}
 */
export async function getBlockNumber() {
  try {
    const provider = activeProvider === 'primary' ? getPrimaryProvider() : getFallbackProvider();
    const num = await withTimeout(provider.getBlockNumber());
    if (activeProvider === 'primary') {
      consecutivePrimaryFailures = 0;  // reset on success
    }
    return num;
  } catch (err) {
    if (activeProvider === 'primary') {
      handlePrimaryFailure(err);
      // Retry immediately on fallback
      return withTimeout(getFallbackProvider().getBlockNumber());
    }
    throw err;
  }
}

/**
 * Fetch a full block with all transactions included.
 *
 * @param {number} blockNumber
 * @returns {Promise<ethers.Block>}
 */
export async function getBlockWithTxs(blockNumber) {
  const fetch = async (provider) => {
    const block = await withTimeout(provider.getBlock(blockNumber, /* prefetchTxs */ true));
    if (!block) throw new Error(`Block ${blockNumber} not found`);
    return block;
  };

  try {
    const provider = activeProvider === 'primary' ? getPrimaryProvider() : getFallbackProvider();
    const block = await fetch(provider);
    if (activeProvider === 'primary') {
      consecutivePrimaryFailures = 0;
    }
    return block;
  } catch (err) {
    if (activeProvider === 'primary') {
      handlePrimaryFailure(err);
      return fetch(getFallbackProvider());
    }
    throw err;
  }
}

/**
 * Gracefully destroy both providers and cancel recovery timer.
 * Call this on service shutdown.
 */
export function destroyProviders() {
  if (recoveryTimer) {
    clearInterval(recoveryTimer);
    recoveryTimer = null;
  }
  primaryProvider?.destroy();
  fallbackProvider?.destroy();
  primaryProvider = null;
  fallbackProvider = null;
}
