import { runBot } from './bot';

async function main() {
    try {
        await runBot();
    } catch (e) {
        console.error("Bot crashed:", e);
        process.exit(1);
    }
}

main();
