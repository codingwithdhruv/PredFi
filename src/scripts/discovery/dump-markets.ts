
import { ApiClient } from '../../services/api';
import * as fs from 'fs';
import * as path from 'path';

async function dumpAllMarkets() {
    const api = new ApiClient();
    const dumpPath = path.join(process.cwd(), 'all_active_markets.json');

    console.log("🔍 Deep Scanning for ALL markets...");

    let cursor: string | null = null;
    let hasMore = true;
    let totalScanned = 0;
    const allMarketsMap = new Map<number, any>();

    // Phase 1: Fetch ALL markets via cursor pagination
    process.stdout.write("Fetching Markets: ");
    while (hasMore) {
        try {
            const res = await api.getMarkets(100, cursor);
            if (!res.success) break;

            const batch = res.data || [];
            if (batch.length === 0) break;

            for (const m of batch) {
                // Store in map to prevent duplicates
                allMarketsMap.set(m.id, m);
            }

            totalScanned += batch.length;
            process.stdout.write(`.`);

            cursor = res.cursor;
            // Stop if no more cursor OR we got an incomplete batch (end of stream)
            if (!cursor || batch.length < 100) hasMore = false;

            // Safety limit (adjust if needed)
            if (totalScanned > 50000) break;

        } catch (e: any) {
            console.error("\nError fetching markets:", e.message);
            break;
        }
    }
    console.log(`\nFound ${allMarketsMap.size} unique markets across all statuses.`);

    // Phase 2: Filter for Active (Valid) Markets
    const validMarkets = Array.from(allMarketsMap.values()).filter(m => m.status !== 'RESOLVED');
    console.log(`Filtering: ${validMarkets.length} markets are ACTIVE (not resolved).`);

    // Phase 3: Fetch Stats for Active Markets
    console.log("\nFetching latest stats for active markets...");

    const BATCH_SIZE = 25;
    for (let i = 0; i < validMarkets.length; i += BATCH_SIZE) {
        const batch = validMarkets.slice(i, i + BATCH_SIZE);
        if (i % 250 === 0 || i === 0) process.stdout.write(`\rProgress: ${i}/${validMarkets.length}`);

        await Promise.all(batch.map(async (m) => {
            try {
                const stats = await api.getMarketStats(m.id);
                m.stats = stats;
            } catch (err) {
                m.stats = { volume24hUsd: 0, volumeTotalUsd: 0, totalLiquidityUsd: 0 };
            }
        }));
    }
    console.log(`\rProgress: ${validMarkets.length}/${validMarkets.length} - DONE`);

    // Phase 4: Save to file
    fs.writeFileSync(dumpPath, JSON.stringify(validMarkets, null, 2));
    console.log(`\n✅ Saved ${validMarkets.length} active markets with stats to ${dumpPath}`);

    // Summary
    const boosted = validMarkets.filter(m => (m.shareThreshold || 0) > 0);
    console.log(`Summary:`);
    console.log(` - Total Active: ${validMarkets.length}`);
    console.log(` - Boosted: ${boosted.length}`);

    // Sort by 24h Volume and show top 5
    const topByVol = [...validMarkets].sort((a, b) => (b.stats?.volume24hUsd || 0) - (a.stats?.volume24hUsd || 0));
    console.log("\nTop 5 Markets by 24h Volume:");
    topByVol.slice(0, 5).forEach(m => {
        console.log(` - [${m.id}] ${m.title} ($${(m.stats?.volume24hUsd || 0).toLocaleString()})`);
    });
}

dumpAllMarkets();
