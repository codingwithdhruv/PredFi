
import { ApiClient } from '../../services/api';

async function approveWithSdk() {
    console.log("🚀 Initializing SDK for Approvals...");

    const api = new ApiClient();
    await api.init();

    console.log(`Wallet: ${api.getSignerAddress()}`);
    console.log(`Trader: ${api.getTraderAddress()}`);
    console.log("🔄 Checking and Setting Approvals...");

    try {
        const result = await api.setApprovals();

        if (result.success) {
            console.log("✅ All Approvals Verified & Set Successfully!");
        } else {
            console.error("⚠️ Some approvals failed:");
            result.transactions.forEach((tx: any, i: number) => {
                if (!tx.success) {
                    console.error(`   [Op ${i + 1}] Failed: ${tx.cause}`);
                } else {
                    console.log(`   [Op ${i + 1}] Success (Hash: ${tx.receipt?.hash})`);
                }
            });
        }
    } catch (e: any) {
        console.error("❌ Fatal Error during approval process:", e.message);
        if (e.message.includes("insufficient funds")) {
            console.error("👉 You need BNB for gas fees in your EOA wallet!");
        }
    }
}

approveWithSdk();
