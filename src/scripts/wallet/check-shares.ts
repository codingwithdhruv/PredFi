
import { ApiClient } from '../../services/api';
import { CONFIG } from '../../config';
import { formatUnits, ethers } from 'ethers';

async function main() {
    const api = new ApiClient();
    await api.init();

    console.log(`-----------------------------------`);
    console.log(`Signer Address (EOA): ${api.getSignerAddress()}`);
    console.log(`Trader Address (Smart Wallet): ${api.getTraderAddress()}`);
    console.log(`-----------------------------------`);

    const marketId = CONFIG.MARKET_ID;
    console.log(`Market ID: ${marketId}`);

    try {
        const market = await api.getMarket(marketId);
        const yesTokenId = market.outcomes[0].onChainId;
        const noTokenId = market.outcomes[1].onChainId;

        // Ensure correct contract is patched in SDK
        const ctAddress = await api.ensureCorrectContract(market);
        console.log(`Using CT Contract: ${ctAddress}`);

        if (!api.orderBuilder) throw new Error("OrderBuilder not initialized");

        // Use SDK method which now uses the correctly patched contract
        const balYesRaw = await api.orderBuilder.balanceOf(yesTokenId);
        const balNoRaw = await api.orderBuilder.balanceOf(noTokenId);

        const balYes = parseFloat(formatUnits(balYesRaw, 18));
        const balNo = parseFloat(formatUnits(balNoRaw, 18));

        console.log(`-----------------------------------`);
        console.log(`Outcome YES (ID ...${yesTokenId.slice(-4)}): ${balYes.toFixed(4)} Shares`);
        console.log(`Outcome NO  (ID ...${noTokenId.slice(-4)}): ${balNo.toFixed(4)} Shares`);
        console.log(`-----------------------------------`);

    } catch (error: any) {
        console.error("Error checking shares:", error.response?.data || error.message);
    }
}

main();
