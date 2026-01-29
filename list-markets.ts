import { ApiClient } from './src/services/api';

async function list() {
    const api = new ApiClient();
    await api.init();
    const markets = await api.searchMarkets("BTC/USD");

    if (!Array.isArray(markets)) {
        console.log("Raw Response not an array:", JSON.stringify(markets).slice(0, 500));
        return;
    }

    const active = markets.filter((m: any) => !m.resolved);
    console.log(`Found ${active.length} Active BTC/USD Markets:`);
    active.forEach((m: any) => {
        console.log(`- [${m.id}] ${m.title}`);
    });
}

list();
