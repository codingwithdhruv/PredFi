import { runBot } from './bot';
import { DipArbBot } from './strategies/dip-arb-bot';
import { MarketScanner } from './services/market-scanner';
import { ApiClient } from './services/api';
import { CONFIG } from './config';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
    const strategy = process.env.STRATEGY || 'MM';

    if (strategy === 'DIP') {
        console.log("🔵 Starting DIP STRATEGY (Gabagool Port)...");

        const api = new ApiClient();
        await api.init();
        const scanner = new MarketScanner(api);
        let currentBot: DipArbBot | null = null;
        let activeMarketId = CONFIG.MARKET_ID; // Start with env or 0

        // Rotation Loop
        while (true) {
            try {
                // 1. Scan for best market
                console.log("🔄 Scanning for active BTC 15m market...");
                const bestMarketId = await scanner.findBestMarket("BTC", "15m");

                if (bestMarketId) {
                    activeMarketId = bestMarketId;
                } else if (!activeMarketId) {
                    console.log("⚠️ No market found and no default. Retrying in 60s...");
                    await new Promise(r => setTimeout(r, 60000));
                    continue;
                }

                console.log(`🎯 Active Market ID: ${activeMarketId}`);

                // 2. Start Bot
                if (currentBot) {
                    await currentBot.stop();
                }

                currentBot = new DipArbBot(activeMarketId);
                await currentBot.start();

                // 3. Wait for cycle (e.g. 15m? Or check every 1 min if market changed?)
                // Gabagool: "Autoscan every 15m". 
                // Let's sleep 15 mins then restart loop to scan again.
                // Or better: Sleep 5 mins, check if better market exists?
                // User said: "Autoscan the markets every 15mins".

                console.log("💤 Sleeping 15 minutes before next scan...");
                await new Promise(r => setTimeout(r, 15 * 60 * 1000)); // 15m

            } catch (e) {
                console.error("Strategy Loop Error:", e);
                await new Promise(r => setTimeout(r, 10000));
            }
        }
    } else {
        // Default MM
        try {
            await runBot();
        } catch (e) {
            console.error("Bot crashed:", e);
            process.exit(1);
        }
    }
}

main();
