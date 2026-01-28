
import { ApiClient } from '../../services/api';

async function inspectMarket() {
    const marketId = parseInt(process.argv[2] || '785');
    const api = new ApiClient();
    try {
        console.log(`Inspecting Market ID: ${marketId}...`);
        const market = await api.getMarket(marketId);
        console.log("Market Title:", market.title);
        console.log("Question:", market.question);
        console.log("Status:", market.status);

        const stats = await api.getMarketStats(marketId);
        console.log("Stats:", stats);

    } catch (e: any) {
        console.error("Error inspecting market:", e.response?.data || e.message);
    }
}
inspectMarket();
