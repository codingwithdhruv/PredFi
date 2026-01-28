
import { ApiClient } from '../../services/api';
import { CONFIG } from '../../config';
import { formatUnits, ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

async function main() {
    console.log("🚀 Starting Redeem/Merge Script...");
    const api = new ApiClient();
    await api.init();

    const marketId = CONFIG.MARKET_ID;
    console.log(`Target Market ID: ${marketId}`);

    const market = await api.getMarket(marketId);
    const yesTokenId = market.outcomes[0].onChainId;
    const noTokenId = market.outcomes[1].onChainId;
    const conditionId = market.conditionId;

    if (!conditionId) {
        console.error("❌ Error: Market object missing conditionId");
        process.exit(1);
    }

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

    // Strategy 2: Merge (if holding both)
    if (bYesRaw > 0n && bNoRaw > 0n) {
        // Can only merge the minimum of the two
        const amountToMerge = bYesRaw < bNoRaw ? bYesRaw : bNoRaw;
        console.log(`Found overlapping positions. Merging ${formatUnits(amountToMerge, 18)} shares...`);

        try {
            const res = await api.mergePositions(
                conditionId,
                amountToMerge,
                market.isNegRisk,
                market.isYieldBearing
            );
            if (res.success) {
                console.log(`✅ Merge Successful! Tx: ${res.receipt?.hash}`);
            } else {
                console.error(`❌ Merge Failed:`, res.cause);
            }
        } catch (e: any) {
            console.error("Merge Exception:", e.message);
        }
    } else {
        console.log("No overlapping positions to merge.");
    }

    // Strategy 3: Redeem (payout)
    // If market status says resolved?
    if (market.status === 'RESOLVED' || market.status === 'CLOSED') {
        console.log("Market appears resolved. Attempting redemption...");

        const redeem = async (indexSet: 1 | 2, amount: bigint) => {
            try {
                const res = await api.redeemPositions(
                    conditionId,
                    indexSet,
                    amount,
                    market.isNegRisk,
                    market.isYieldBearing
                );
                if (res.success) {
                    console.log(`✅ Redeem (Index ${indexSet}) Successful! Tx: ${res.receipt?.hash}`);
                } else {
                    console.error(`❌ Redeem (Index ${indexSet}) Failed:`, res.cause);
                }
            } catch (e: any) {
                console.error(`Redeem (Index ${indexSet}) Exception:`, e.message);
            }
        };

        if (bYesRaw > 0n) await redeem(1, bYesRaw);
        if (bNoRaw > 0n) await redeem(2, bNoRaw);

    } else {
        console.log("Market status: " + market.status);
        console.log("Skipping redemption check (Market not RESOLVED).");
    }

    console.log("Done.");
}

main();
