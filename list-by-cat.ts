import axios from 'axios';
import { CONFIG } from './src/config';

async function listByCat(slug: string) {
    const res = await axios.get(`${CONFIG.API_BASE_URL}/v1/categories/${slug}`, {
        headers: { 'x-api-key': CONFIG.API_KEY || '' }
    });
    console.log(`Markets for ${slug}:`);
    res.data.data.markets.forEach((m: any) => {
        console.log(`- [${m.id}] ${m.title}`);
    });
}

listByCat("btc-usd-up-down-2026-01-29-03-00-15-minutes");
