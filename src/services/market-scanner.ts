import { ApiClient } from './api';
import { DateTime } from 'luxon';

export class MarketScanner {
    private api: ApiClient;

    constructor(api: ApiClient) {
        this.api = api;
    }

    /**
     * Scans for the latest BTC 15m market matching the current ET time slot.
     */
    async findBestMarket(ticker: string = "BTC", duration: string = "15m"): Promise<number | null> {
        console.log(`🔎 Scanning for ${ticker} ${duration} markets (Category-based)...`);
        try {
            // 1. Determine Current Target Slot & Range
            const nowET = DateTime.now().setZone('America/New_York');
            const currentMinute = nowET.minute;

            // Format for Title: "January 29"
            const dateStr = nowET.toFormat('MMMM d');

            // We want the market that STARTS now or NEXT.
            const startMinute = Math.floor(currentMinute / 15) * 15;
            const endMinute = startMinute + 15;

            const startTimeET = nowET.set({ minute: startMinute, second: 0, millisecond: 0 });
            const endTimeET = startTimeET.set({ minute: endMinute % 60 }).plus({ hours: endMinute >= 60 ? 1 : 0 });

            // Range Format: "3:00-3:15AM"
            const timeRangeStr = `${startTimeET.toFormat('h:mm')}-${endTimeET.toFormat('h:mm a')}`.replace(' ', '');
            console.log(`🕒 Current ET: ${nowET.toFormat('h:mm a')} | Target: ${dateStr}, ${timeRangeStr} ET`);

            // 2. Fetch Latest Categories to find the correct BTC/USD 15m slot
            // Predicted slug pattern: btc-usd-up-down-YYYY-MM-DD-HH-MM-15-minutes
            const catRes = await this.api.client.get('/v1/categories');
            const categories = catRes.data.data;

            // Search for categories matching btc, 15-minutes, and today's date
            const todayISO = nowET.toFormat('yyyy-MM-dd');
            const targetCat = categories.find((c: any) =>
                c.slug.includes("btc-usd-up-down") &&
                c.slug.includes(todayISO) &&
                c.slug.includes("15-minutes") &&
                (c.slug.includes(startTimeET.toFormat('HH-mm')) || c.slug.includes(endTimeET.toFormat('HH-mm')))
            );

            if (targetCat) {
                console.log(`📂 Found Category: ${targetCat.slug}`);
                // Fetch markets in this category
                const catInfoRes = await this.api.client.get(`/v1/categories/${targetCat.slug}`);
                const marketsInCat = catInfoRes.data.data.markets;

                const bestMarket = marketsInCat.find((m: any) =>
                    !m.resolved &&
                    m.title.includes(dateStr) && (
                        m.title.includes(timeRangeStr) ||
                        m.title.includes(timeRangeStr.replace('-', ' - '))
                    )
                );

                if (bestMarket) {
                    console.log(`✅ Match Found: [${bestMarket.id}] ${bestMarket.title}`);
                    return bestMarket.id;
                }
            }

            // Fallback: Global search if category fails
            console.log("⚠️ Category match failed. Falling back to global search...");
            const markets = await this.api.searchMarkets(`BTC/USD ${duration}`);
            const activeMarkets = markets.filter((m: any) => !m.resolved && m.title.includes("BTC/USD"));

            const bestMatch = activeMarkets.find((m: any) =>
                m.title.includes(dateStr) && (
                    m.title.includes(timeRangeStr) ||
                    m.title.includes(timeRangeStr.replace('-', ' - '))
                )
            );

            if (bestMatch) {
                console.log(`✅ Global Match Found: [${bestMatch.id}] ${bestMatch.title}`);
                return bestMatch.id;
            }

            return null;

        } catch (e) {
            console.error("Scanner Error:", e);
            return null;
        }
    }
}
