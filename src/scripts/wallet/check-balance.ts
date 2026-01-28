
import { ApiClient } from '../../services/api';

async function checkBalance() {
    const api = new ApiClient();

    console.log(`-----------------------------------`);
    console.log(`Signer Address (EOA): ${api.getSignerAddress()}`);
    console.log(`Trader Address (Smart): ${api.getTraderAddress()}`);
    console.log(`Note: BNB is needed on the Signer for Gas.`);
    console.log(`-----------------------------------`);

    try {
        const balance = await api.getBNBBalance();
        console.log(`BNB Balance: ${balance}`);
    } catch (error: any) {
        console.error("Failed to fetch balance:", error.message);
    }
}
checkBalance();
