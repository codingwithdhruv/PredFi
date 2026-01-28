
import { ApiClient } from '../../services/api';

async function main() {
    console.log("🔍 Finding your correct Predict Account...");

    const api = new ApiClient();

    try {
        await api.init();

        console.log("Fetching account details...");
        const account = await api.getAccount();

        console.log("\n--- ACCOUNT INFO ---");
        console.log(JSON.stringify(account, null, 2));

        if (account.predictAccount) {
            console.log(`\n✅ YOUR PREDICT ACCOUNT: ${account.predictAccount}`);
            console.log("Make sure to put this in your .env as PREDICT_ACCOUNT");
        } else {
            console.log("\nNo dedicated Predict Account found for this EOA. You are likely trading directly from your EOA.");
        }

    } catch (error: any) {
        console.error("Error:", error.response?.data || error.message);
    }
}

main();
