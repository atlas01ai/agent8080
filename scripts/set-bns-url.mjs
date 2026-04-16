/**
 * Set BNS Text Record for agent8080.base.eth
 * Uses ethers.js to interact with Base Name Service (ENS-compatible)
 */

import { ethers } from 'ethers';
import dotenv from 'dotenv';
import { readFileSync } from 'fs';

dotenv.config();

// Configuration
const BNS_NAME = 'agent8080.base.eth';
const URL_VALUE = 'https://atlas01ai.github.io/agent8080/';
const TEXT_KEY = 'url';

// Base L2 Provider (using Alchemy)
const provider = new ethers.JsonRpcProvider(
  process.env.BASE_RPC_URL || 'https://mainnet.base.org'
);

// Wallet (must have AGENT_PRIVATE_KEY in .env)
if (!process.env.AGENT_PRIVATE_KEY) {
  console.error('❌ AGENT_PRIVATE_KEY not found in .env');
  console.error('   Add: AGENT_PRIVATE_KEY=0x...');
  process.exit(1);
}

const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY, provider);

// ENS Registry on Base
// Basenames uses the same ENS architecture
const ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'; // ENS mainnet registry (different on Base)

// For Base, we need the Base-specific registry
// Actually, Basenames uses ENS infrastructure
const BASE_ENS_REGISTRY = '0x00000000000C2E074eC69A0dFb2997BA6C7d2e1e'; // Same contract on Base

// ABI for ENS Registry (simplified)
const REGISTRY_ABI = [
  'function resolver(bytes32 node) external view returns (address)',
  'function owner(bytes32 node) external view returns (address)'
];

// ABI for Public Resolver
const RESOLVER_ABI = [
  'function setText(bytes32 node, string calldata key, string calldata value) external',
  'function text(bytes32 node, string calldata key) external view returns (string memory)'
];

async function setBnsUrlRecord() {
  try {
    console.log(`🌐 Setting BNS Text Record for ${BNS_NAME}`);
    console.log(`   Key: ${TEXT_KEY}`);
    console.log(`   Value: ${URL_VALUE}`);
    console.log(`   Wallet: ${wallet.address}`);
    console.log();

    // Get ENS node (namehash)
    const node = ethers.namehash(BNS_NAME);
    console.log(`📍 ENS Node: ${node}`);

    // Connect to registry
    const registry = new ethers.Contract(BASE_ENS_REGISTRY, REGISTRY_ABI, wallet);

    // Get current resolver
    const resolverAddress = await registry.resolver(node);
    console.log(`🔍 Current Resolver: ${resolverAddress}`);

    if (resolverAddress === '0x0000000000000000000000000000000000000000') {
      console.error('❌ No resolver set for this name');
      console.error('   You need to set a resolver first via Basenames UI');
      process.exit(1);
    }

    // Check ownership
    const owner = await registry.owner(node);
    console.log(`👤 Owner: ${owner}`);

    if (owner.toLowerCase() !== wallet.address.toLowerCase()) {
      console.error('❌ Wallet is not the owner of this name');
      console.error(`   Owner: ${owner}`);
      console.error(`   Wallet: ${wallet.address}`);
      process.exit(1);
    }

    // Connect to resolver
    const resolver = new ethers.Contract(resolverAddress, RESOLVER_ABI, wallet);

    // Check current value
    const currentValue = await resolver.text(node, TEXT_KEY);
    console.log(`📋 Current Value: ${currentValue || '(not set)'}`);

    if (currentValue === URL_VALUE) {
      console.log('✅ URL already set to desired value');
      return;
    }

    // Estimate gas
    const gasEstimate = await resolver.setText.estimateGas(node, TEXT_KEY, URL_VALUE);
    console.log(`⛽ Gas Estimate: ${gasEstimate.toString()} units`);

    // Get gas price
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice;
    const estimatedCost = gasEstimate * gasPrice;
    console.log(`💰 Estimated Cost: ${ethers.formatEther(estimatedCost)} ETH`);
    console.log(`   Gas Price: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`);
    console.log();

    // Get wallet balance
    const balance = await provider.getBalance(wallet.address);
    console.log(`💵 Wallet Balance: ${ethers.formatEther(balance)} ETH`);

    if (balance < estimatedCost) {
      console.error('❌ Insufficient balance for transaction');
      process.exit(1);
    }

    // Confirm (in production, this would be automatic or have a flag)
    console.log('🚀 Ready to send transaction...');
    console.log('   In autonomous mode, this would execute automatically.');
    console.log('   For safety, set AUTO_EXECUTE_BNS=true in .env to proceed.');
    console.log();

    if (process.env.AUTO_EXECUTE_BNS !== 'true') {
      console.log('⏸️ Transaction NOT sent (safety mode)');
      console.log('   To execute: Set AUTO_EXECUTE_BNS=true in .env');
      console.log('   Or manually execute via Basenames UI:');
      console.log('   https://www.base.org/names');
      return;
    }

    // Send transaction
    console.log('📤 Sending transaction...');
    const tx = await resolver.setText(node, TEXT_KEY, URL_VALUE);
    console.log(`   TX Hash: ${tx.hash}`);
    console.log(`   Waiting for confirmation...`);

    const receipt = await tx.wait();
    console.log(`✅ Transaction confirmed in block ${receipt.blockNumber}`);
    console.log(`   Gas used: ${receipt.gasUsed.toString()}`);

    // Verify
    const newValue = await resolver.text(node, TEXT_KEY);
    console.log(`✅ New Value: ${newValue}`);

    if (newValue === URL_VALUE) {
      console.log('🎉 BNS URL record successfully updated!');
      console.log(`   ${BNS_NAME} → ${URL_VALUE}`);
    } else {
      console.error('❌ Verification failed');
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    if (error.code) console.error('   Code:', error.code);
    if (error.reason) console.error('   Reason:', error.reason);
    process.exit(1);
  }
}

setBnsUrlRecord();
