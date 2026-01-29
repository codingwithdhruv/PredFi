import { ApiClient } from './api';

export class MarketScanner {
    private api: ApiClient;

    constructor(api: ApiClient) {
        this.api = api;
    }

    /**
     * Scans for the latest ACTIVE or UPCOMING market for a given ticker and duration.
     * @param ticker "BTC" or "ETH"
     * @param duration "15m" or "5m"
     */
    async findBestMarket(ticker: string = "BTC", duration: string = "15m"): Promise<number | null> {
        console.log(`🔎 Scanning for ${ticker} ${duration} markets...`);
        try {
            // Search string e.g. "BTC 15m"
            const query = `${ticker} ${duration}`;
            const markets = await this.api.searchMarkets(query);

            if (!markets || markets.length === 0) {
                console.log(`❌ No markets found for "${query}"`);
                return null;
            }

            // Filter for exact match on duration to avoid partial matches
            // Predict market titles usually look like: "Will BTC be > 90000 at 10:00?"
            // We want to find the one that is currently LIVE or STARTING SOON.

            const now = Date.now();
            let bestMarket: any = null;

            // Sort by start time DESC (newest first)
            // But we actually want the one that is "in progress" or "just about to start"
            // Predict markets have 'resolutionDate' and sometimes 'createdAt'.

            // Let's filter for markets that are NOT resolved
            const activeMarkets = markets.filter((m: any) => !m.resolved);

            if (activeMarkets.length === 0) {
                console.log("❌ All found markets are resolved.");
                return null;
            }

            // Pick the one with the closest resolution date in the future?
            // "15m" markets resolve every 15 minutes.
            // We want the ONE currently trading.

            activeMarkets.sort((a: any, b: any) => {
                const resA = new Date(a.resolutionDate).getTime();
                const resB = new Date(b.resolutionDate).getTime();
                return resB - resA; // Newest first
            });

            // Let's log the top candidates
            // console.log("Candidates:", activeMarkets.map(m => `${m.id}: ${m.title} (Res: ${m.resolutionDate})`).slice(0, 3));

            // Return the most recent unresolved market
            // Usually the one closing soonest (but still in future) is the active one? 
            // Or the one closing furthest? 
            // "Start market rotation loop" -> "Scan Upcoming Markets" from user prompt suggests we want the next cycle?
            // "Get the latest btc valid up down market" -> Usually means the current active cycle.

            // Let's grab the one that closes NEXT.
            const upcoming = activeMarkets.filter((m: any) => new Date(m.resolutionDate).getTime() > now);
            upcoming.sort((a: any, b: any) => new Date(a.resolutionDate).getTime() - new Date(b.resolutionDate).getTime()); // Ascending (Closing soonest)

            if (upcoming.length > 0) {
                bestMarket = upcoming[0];
            } else {
                // Return latest even if technically past resolution (if API is slow to mark resolved)
                bestMarket = activeMarkets[0];
            }

            if (bestMarket) {
                console.log(`✅ Found Market: [${bestMarket.id}] ${bestMarket.title}`);
                console.log(`   Resolution: ${bestMarket.resolutionDate}`);
                return bestMarket.id;
            }

            return null;

        } catch (e) {
            console.error("Scanner Error:", e);
            return null;
        }
    }
}
