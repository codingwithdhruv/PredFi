
import { ApiClient } from '../../services/api';

async function searchMarket() {
    const keyword = process.argv[2];
    if (!keyword) {
        console.log("Usage: npx ts-node src/scripts/discovery/search-market.ts <keyword>");
        return;
    }

    const api = new ApiClient();
    console.log(`🔍 Searching for markets containing: "${keyword}"...`);

    let cursor: string | null = null;
    let hasMore = true;
    let found = false;

    process.stdout.write("Scanning: ");
    while (hasMore) {
        try {
            const res = await api.getMarkets(100, cursor);
            if (!res.success) break;

            const markets = res.data || [];
            process.stdout.write(".");

            for (const m of markets) {
                if (m.title.toLowerCase().includes(keyword.toLowerCase()) ||
                    m.question.toLowerCase().includes(keyword.toLowerCase())) {
                    console.log(`\nFound: [${m.id}] ${m.title}`);
                    console.log(`   Q: ${m.question}`);
                    console.log(`   Status: ${m.status} | Category: ${m.categorySlug}`);
                    console.log(`------------------------------------------------`);
                    found = true;
                }
            }

            cursor = res.cursor;
            if (!cursor || markets.length < 100) hasMore = false;
        } catch (e: any) {
            console.error("\nError:", e.message);
            hasMore = false;
        }
    }

    console.log("\nDone.");
    if (!found) {
        console.log(`No markets found matching "${keyword}".`);
    }
}

searchMarket();
