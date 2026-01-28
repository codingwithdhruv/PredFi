
import { ApiClient } from '../../services/api';
import { CONFIG } from '../../config';
import { formatUnits, parseUnits, ethers } from 'ethers';
import { Side } from '@predictdotfun/sdk';
import dotenv from 'dotenv';

dotenv.config();

async function main() {
    console.log("🚀 Starting Sell All Shares Script...");
    const api = new ApiClient();
    await api.init();

    const marketId = CONFIG.MARKET_ID;
    console.log(`Target Market ID: ${marketId}`);

    // 1. Cancel Open Orders
    console.log("Canceling all open orders to free up inventory...");
    const orders = await api.getOpenOrders();
    const myOrders = orders.filter((o: any) => o.order?.maker?.toLowerCase() === api.getAddress().toLowerCase());

    if (myOrders.length > 0) {
        const ids = myOrders.map((o: any) => o.id);
        await api.removeOrders(ids);
        console.log(`✅ Cancelled ${ids.length} orders.`);
    } else {
        console.log("No open orders found.");
    }

    // 2. Refresh Market Info
    const market = await api.getMarket(marketId);
    const yesTokenId = market.outcomes[0].onChainId;
    const noTokenId = market.outcomes[1].onChainId;

    // 3. Check Balances (using OrderBuilder for consistency with main bot)
    if (!api.orderBuilder) throw new Error("OrderBuilder not ready");

    // Ensure correct CT contract
    await api.ensureCorrectContract(market);

    const ct = api.orderBuilder.contracts!.CONDITIONAL_TOKENS.contract;
    const runner = ct.runner;
    const ctAddress = await (ct as any).getAddress();

    const targetCt = new ethers.Contract(ctAddress, [
        "function balanceOf(address account, uint256 id) view returns (uint256)"
    ], runner as any);

    const bYesRaw = await targetCt.balanceOf(api.getAddress(), yesTokenId);
    const bNoRaw = await targetCt.balanceOf(api.getAddress(), noTokenId);

    const bYes = parseFloat(formatUnits(bYesRaw, 18));
    const bNo = parseFloat(formatUnits(bNoRaw, 18));

    console.log(`Inventory: YES=${bYes.toFixed(4)}, NO=${bNo.toFixed(4)}`);

    const sell = async (tokenName: string, tokenId: string, amountWei: bigint) => {
        if (amountWei <= 0n) return;

        console.log(`Selling ${tokenName}...`);
        // Dump price: 0.05 (Floor)
        const priceWei = parseUnits("0.05", 18); // Sell at 5 cents

        try {
            const res = await api.placeLimitOrder(
                priceWei,
                amountWei,
                Side.SELL,
                tokenId,
                market.isNegRisk,
                market.isYieldBearing,
                market.feeRateBps
            );

            if (res.success) {
                console.log(`✅ ${tokenName} Sell Order Placed: ${res.data.orderId}`);
            } else {
                console.error(`❌ ${tokenName} Sell Failed:`, res);
            }
        } catch (e: any) {
            console.error(`❌ ${tokenName} Sell Error:`, e?.response?.data || e.message);
        }
    };

    await sell("YES", yesTokenId, bYesRaw);
    await sell("NO", noTokenId, bNoRaw);

    console.log("Done.");
}

main();
