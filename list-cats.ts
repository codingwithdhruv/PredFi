import axios from 'axios';
import { CONFIG } from './src/config';

async function listCats() {
    const res = await axios.get(`${CONFIG.API_BASE_URL}/v1/categories`, {
        headers: { 'x-api-key': CONFIG.API_KEY || '' }
    });
    console.log("Categories:");
    res.data.data.forEach((c: any) => {
        console.log(`- [${c.slug}] ${c.name}`);
    });
}

listCats();
