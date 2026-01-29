import dotenv from 'dotenv';
import { ChainId } from '@predictdotfun/sdk';

dotenv.config();

export const CONFIG = {
    PRIVATE_KEY: process.env.PRIVATE_KEY || '',
    API_KEY: process.env.API_KEY || '',
    CHAIN_ID: parseInt(process.env.CHAIN_ID || '56') as ChainId, // Default 56 (BNB Mainnet)
    API_BASE_URL: process.env.API_BASE_URL || 'https://api.predict.fun',
    WS_URL: process.env.WS_URL || 'wss://ws.predict.fun/ws',
    MARKET_ID: parseInt(process.env.MARKET_ID || '0'),
    MARKET_ID_2: process.env.MARKET_ID_2 ? parseInt(process.env.MARKET_ID_2) : undefined,
    SPREAD: parseFloat(process.env.SPREAD || '0.04'), // Default spread for farming
    SIZE: parseFloat(process.env.SIZE || '50'), // Min 50 shares for points
    PRICE_ADJUST_INTERVAL: 1000,
    MAX_REWARDS_SPREAD: parseFloat(process.env.MAX_REWARDS_SPREAD || '0.06'), // ±6¢
    MIN_SHARES: parseFloat(process.env.MIN_SHARES || '50'),
    REQUOTE_THRESHOLD: 0.005,      // 0.5% (50 basis points) change triggers requote
    MAX_ORDERS: 10,
    PREDICT_ACCOUNT: process.env.PREDICT_ACCOUNT?.trim(), // Optional: Correct EOA address or Smart Wallet address
    MIN_DIST_FROM_MID: parseFloat(process.env.MIN_DIST_FROM_MID || '0.03'), // Min 3 cents away from mid
    MAX_DIST_FROM_MID: parseFloat(process.env.MAX_DIST_FROM_MID || '0.10'), // Max 10 cents away from mid (Stale)
    LIQUIDITY_SCAN_THRESHOLD: parseFloat(process.env.LIQUIDITY_SCAN_THRESHOLD || '500'), // Join walls > 500 shares
    SAFETY_DELAY_AFTER_CANCEL: 2000, // 2s delay after cancelling before placing new orders

    // DIP STRATEGY SETTINGS
    DIP_MAX_RISK_PCT: parseFloat(process.env.DIP_MAX_RISK_PCT || '0.15'),
    DIP_THRESHOLD: parseFloat(process.env.DIP_THRESHOLD || '0.15'),   // 15% drop
    DIP_WINDOW_MS: parseInt(process.env.DIP_WINDOW_MS || '3000'),     // 3s window
    DIP_SUM_TARGET: parseFloat(process.env.DIP_SUM_TARGET || '0.95'), // Entry Sum <= 0.95
    DIP_SHARES: 50, // Fixed 50 shares
    DIP_LEG2_TIMEOUT_MS: 60000, // 60s force hedge
};

if (CONFIG.PREDICT_ACCOUNT && !CONFIG.PREDICT_ACCOUNT.startsWith('0x')) {
    console.error('❌ ERROR: PREDICT_ACCOUNT must be a 0x-prefixed address (the one from the website).');
    console.error('👉 If you have a Private Key, put it in PRIVATE_KEY instead.');
    throw new Error('Invalid PREDICT_ACCOUNT format');
}
if (!CONFIG.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY is missing in .env');
}
if (!CONFIG.API_KEY && CONFIG.CHAIN_ID === ChainId.BnbMainnet) {
    console.error("Missing API_KEY in .env");
    process.exit(1);
}
