import { MarketMaker } from './bot';
import { DipArbBot } from './strategies/dip-arb-bot';
import { CONFIG } from './config';

async function main() {
    const strategy = process.env.STRATEGY || 'MM'; // Default Market Maker / Points Farmer

    console.log(`Starting with strategy: ${strategy}`);

    let bot;
    if (strategy === 'DIP') {
        bot = new DipArbBot(CONFIG.MARKET_ID);
    } else {
        bot = new MarketMaker();
    }

    try {
        await bot.start();
    } catch (e) {
        console.error("Bot failed to start:", e);
        process.exit(1);
    }

    // Keep alive
    process.on('SIGINT', () => {
        console.log("Shutting down...");
        process.exit(0);
    });
}

main();
