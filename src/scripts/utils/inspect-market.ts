
import { ApiClient } from '../../services/api';

async function inspectMarket() {
    const api = new ApiClient();
    try {
        const id = 5133;
        console.log(`Inspecting Market ID: ${id}...`);
        const market = await api.getMarket(id);
        console.log("Keys available in market object:");
        console.log(Object.keys(market));
        console.log("Full sample:", JSON.stringify(market, null, 2));

        const stats = await api.getMarketStats(id);
        console.log("Stats:", stats);

    } catch (e: any) {
        console.error("Error inspecting market:", e.message);
    }
}
inspectMarket();
