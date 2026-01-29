import { runBot } from './bot';
import { DipArbBot } from './strategies/dip-arb-bot';
import { MarketScanner } from './services/market-scanner';
import { ApiClient } from './services/api';
import { CONFIG } from './config';
import dotenv from 'dotenv';
dotenv.config();

import { startTelegramBot } from './services/telegram-bot';

async function main() {
    const strategy = process.env.STRATEGY || 'MM';

    // 1. Shared API Initialization
    const api = new ApiClient();
    try {
        await api.init();
    } catch (e) {
        console.error("Critical: Failed to initialize API:", e);
        process.exit(1);
    }

    // 2. Start Telegram Bot Sidecar (Non-blocking)
    startTelegramBot(api);

    if (strategy === 'DIP') {
        console.log("🔵 Starting DIP STRATEGY (Gabagool Port)...");

        const scanner = new MarketScanner(api);
        let currentBot: DipArbBot | null = null;
        let activeMarketId = CONFIG.MARKET_ID; // Start with env or 0

        // Rotation Loop
        while (true) {
            try {
                // 1. Scan for best market (BTC 15m ET Slot)
                const bestMarketId = await scanner.findBestMarket("BTC", "15m");

                if (bestMarketId) {
                    if (bestMarketId !== activeMarketId) {
                        console.log(`🎯 New Market Detected: ${bestMarketId}. Switching...`);
                        if (currentBot) {
                            await currentBot.stop();
                        }
                        activeMarketId = bestMarketId;
                        currentBot = new DipArbBot(activeMarketId, api);
                        await currentBot.start();
                    }
                } else {
                    console.log("⚠️ No valid BTC 15m market slot found. Retrying in 2 mins...");
                }

                // 2. Wait 2 minutes before checking for the next slot
                // We check frequently to catch the "Next" market as soon as it's created.
                await new Promise(r => setTimeout(r, 2 * 60 * 1000));

            } catch (e) {
                console.error("Strategy Loop Error:", e);
                await new Promise(r => setTimeout(r, 10000));
            }
        }
    } else {
        // Default MM
        try {
            await runBot(api);
        } catch (e) {
            console.error("Bot crashed:", e);
            process.exit(1);
        }
    }
}

main();
