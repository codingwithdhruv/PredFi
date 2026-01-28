
import { ApiClient } from '../../services/api';

async function checkUSDT() {
    const api = new ApiClient();
    try {
        await api.init();

        console.log(`-----------------------------------`);
        console.log(`Signer Address (EOA): ${api.getSignerAddress()}`);
        console.log(`Trader Address (Smart): ${api.getTraderAddress()}`);
        console.log(`-----------------------------------`);

        const balance = await api.getUSDTBalance();
        console.log(`USDT Balance: ${balance}`);
    } catch (error: any) {
        console.error("Failed to fetch USDT balance:", error.message);
    }
}
checkUSDT();
