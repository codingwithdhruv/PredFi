
import { ApiClient } from '../../services/api';

async function findOptimalMarkets() {
    const api = new ApiClient();
    // No need to init() full SDK (OrderBuilder) just for reading markets, 
    // but ApiClient methods might depend on axios instance which is created in constructor.
    // However, ApiClient.init() does Auth which is good practice.

    console.log("🔍 Scanning Markets for Optimal Points Farming...");

    let cursor: string | null = null;
    let hasMore = true;
    let totalScanned = 0;
    const candidates: any[] = [];

    // Phase 1: Scan all markets (fast, no stats yet)
    process.stdout.write("Scanning: ");
    while (hasMore) {
        try {
            const res = await api.getMarkets(100, cursor);
            if (!res.success) break;

            const batch = res.data || [];
            totalScanned += batch.length;

            // Filter efficiently
            for (const m of batch) {
                if (m.status !== 'RESOLVED' && m.shareThreshold > 0) {
                    candidates.push(m);
                }
            }

            process.stdout.write(`.`);
            cursor = res.cursor;
            if (!cursor || batch.length < 100) hasMore = false;

            // Safety break to avoid infinite loops if API is weird
            if (totalScanned > 10000) break;

        } catch (e: any) {
            console.error("\nError fetching markets:", e.message);
            break;
        }
    }

    console.log(`\n\n✅ Scanned ${totalScanned} markets.`);
    console.log(`💎 Found ${candidates.length} boosted active candidates.`);

    if (candidates.length === 0) {
        console.log("No markets match criteria.");
        return;
    }

    console.log("Fetching stats for candidates...");

    // Phase 2: Fetch Stats for Candidates (Batch optimized)
    const scored: any[] = [];
    const BATCH_SIZE = 10;

    for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
        const batch = candidates.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(async (m) => {
            const stats = await api.getMarketStats(m.id);
            const vol24h = stats.volume24hUsd || 0;
            const liquidity = stats.totalLiquidityUsd || 0;

            const score = (vol24h * 1.5) + (liquidity * 0.5);

            scored.push({
                id: m.id,
                title: m.title,
                question: m.question,
                status: m.status,
                vol24h,
                volTotal: stats.volumeTotalUsd || 0,
                liquidity,
                shareThreshold: m.shareThreshold,
                spreadThreshold: m.spreadThreshold,
                score
            });
        }));
    }

    // Sort by Score
    scored.sort((a, b) => b.score - a.score);

    console.log(`\n🏆 TOP 15 MARKETS FOR POINTS FARMING:`);
    console.log(`================================================================`);
    scored.slice(0, 15).forEach((m, idx) => {
        console.log(`${idx + 1}. [ID: ${m.id}] ${m.title}`);
        console.log(`   Q: ${m.question}`);
        console.log(`   Status: ${m.status}`);
        console.log(`   Vol 24h: $${m.vol24h.toLocaleString()} | Total: $${m.volTotal.toLocaleString()}`);
        console.log(`   Liquidity: $${m.liquidity.toLocaleString()}`);
        console.log(`   Points: Min ${m.shareThreshold} shares | Max spread ±${m.spreadThreshold}%`);
        console.log(`   Rank Score: ${m.score.toFixed(0)}`);
        console.log(`----------------------------------------------------------------`);
    });
}

findOptimalMarkets();
