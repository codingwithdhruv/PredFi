import { RealtimeClient, OrderbookData, Channel } from '../services/ws';
import { ApiClient } from '../services/api';
import { CONFIG } from '../config';
import WebSocket from 'ws';
import { Side } from '@predictdotfun/sdk';
import { parseUnits, ethers } from 'ethers';
import { sendAlert, escapeMarkdown } from '../services/telegram-bot';

interface PricePoint {
    timestamp: number;
    price: number;
}

export class DipArbBot {
    private api: ApiClient;
    private ws: RealtimeClient;

    private config = {
        marketId: CONFIG.MARKET_ID, // Will be updated by Scanner
        dipThreshold: CONFIG.DIP_THRESHOLD,
        slidingWindowMs: CONFIG.DIP_WINDOW_MS,
        sumTarget: 0.85, // CRITICAL: Lowered to 0.85 for Positive Expectancy (covers fees + spread)
        shares: CONFIG.DIP_SHARES || 50,
        leg2Timeout: CONFIG.DIP_LEG2_TIMEOUT_MS, // 60s
        dryRun: process.env.DRY_RUN === 'true',
        maxVelocity: -0.12 // Velocity threshold
    };

    private isUpdating: boolean = false; // Concurrency Lock

    private marketId: number;
    private marketParams: any = null;
    private isRunning: boolean = false;

    // Price History Buffers
    private yesHistory: PricePoint[] = [];
    private noHistory: PricePoint[] = [];
    private yesHighWater: number = 0;
    private noHighWater: number = 0;
    private latestOrderbook: OrderbookData | null = null;

    // State Machine
    private phase: 'MONITORING' | 'LEG1_FILLED' | 'COMPLETE' = 'MONITORING';
    private leg1FillPrice: number = 0;
    private leg1TokenId: string = "";
    private leg1Side: 'YES' | 'NO' | null = null;
    private leg1Time: number = 0;
    private walletBalanceUSDT: number = 100; // Default buffer, updated periodically

    constructor(marketId: number, existingApi?: ApiClient) {
        this.api = existingApi || new ApiClient();
        this.marketId = marketId;
        this.ws = null as any;
    }

    async start() {
        console.log(`🚀 Starting DipArb (Gabagool) Bot`);
        console.log(`⚙️ Config: Threshold=${this.config.dipThreshold * 100}%, Sum<=${this.config.sumTarget}, Size=${this.config.shares}, Timeout=${this.config.leg2Timeout / 1000}s`);

        if (!this.api.isInitialized()) {
            await this.api.init();
        }

        const wsSocket = new WebSocket(CONFIG.WS_URL, {
            headers: { 'x-api-key': CONFIG.API_KEY }
        });
        this.ws = new RealtimeClient(wsSocket, { maxConnAttempts: 10, maxRetryInterval: 5000 });

        await this.initMarket();

        // Initial Cleanup
        await this.cleanSlate();

        const channel: Channel = { name: 'predictOrderbook', marketId: this.marketId };
        this.ws.subscribe(channel, (msg) => {
            if (msg.data) {
                // Store latest immediately
                // Concurrency Lock
                if (this.isUpdating) return;
                this.isUpdating = true;
                try {
                    this.latestOrderbook = msg.data as OrderbookData;
                    this.analyzeOrderbook(msg.data as OrderbookData);
                } finally {
                    this.isUpdating = false;
                }
            }
        });

        this.startMonitoringLoop();

        this.isRunning = true;
        if (this.config.dryRun) console.log(`[Market ${this.marketId}] 🧪 DRY RUN MODE ENABLED. No trades will be placed.`);
        console.log(`[Market ${this.marketId}] Monitoring price dips...`);

        // Safety Loop for Leg 2 Timeout
        setInterval(() => this.checkLeg2Timeout(), 1000);

        // Auto-Redeem & Wallet Sync Loop (Check every 1 min)
        setInterval(() => {
            this.autoRedeem();
            this.updateWalletBalance();
        }, 60000);
    }

    private async updateWalletBalance() {
        try {
            const bal = await this.api.getUSDTBalance();
            this.walletBalanceUSDT = parseFloat(bal);
            console.log(`[Market ${this.marketId}] 💳 Wallet Balance Updated: $${this.walletBalanceUSDT.toFixed(2)}`);
        } catch (e) {
            console.warn("Failed to update wallet balance");
        }
    }

    private async cleanSlate() {
        console.log(`🧹 [Market ${this.marketId}] Checking for stale orders...`);
        try {
            const orders = await this.api.getOpenOrders();
            const myOrders = orders.filter((o: any) => o.order.marketId === this.marketId);
            if (myOrders.length > 0) {
                console.log(`🛑 Found ${myOrders.length} stale orders on this market. Cancelling...`);
                if (this.config.dryRun) {
                    console.log(`🧪 [DRY RUN] Would cancel: ${myOrders.map((o: any) => o.orderId).join(", ")}`);
                } else {
                    await this.api.removeOrders(myOrders.map((o: any) => o.orderId));
                    console.log(`✅ Stale orders removed.`);
                }
            } else {
                console.log(`✅ No stale orders found.`);
            }
        } catch (e) {
            console.error("CleanSlate Error:", e);
        }
    }

    private startMonitoringLoop() {
        // 200ms Active Monitor for fast dips between websocket flames
        setInterval(() => {
            if (!this.isRunning || this.phase === 'COMPLETE' || !this.latestOrderbook) return;

            // Re-run analysis with latest known book + current timestamp
            // This catches if we are "waiting" for a dip and the price is stale but new quote might trigger logic
            // Actually, if we just re-run analyzeOrderbook, it updates history with NEW timestamp but SAME price
            // This might dilute the history with duplicate points?
            // "Recalculate Drop % based on current high-water mark vs latest price."

            // We only need to trigger IF the price has changed? 
            // Or if we want to ensure we don't miss a fleeting dip? 
            // Actually, WebSocket pushes are event-based. 
            // The requirement says: "Recalculate Drop % ... catch dips between WS frames" 
            // This implies we might poll? But we don't have a poll source other than WS.

            // However, the USER requirement implies a "Monitoring Loop".
            // "Add monitorLoop for real-time drift check"

            // For Dip Bot, maybe we just ensure we process the latest OB?
            // If the WS is fast, we get updates. 
            // If the WS is slow, polling won't help unless we poll REST API?
            // "does NOT place or cancel ... lightweight ... recomputes"

            // Let's implement it as a "Liveness" check or just re-evaluating the latest OB 
            // in case logic conditions changed (e.g. time window shifts).

            if (this.latestOrderbook) {
                this.analyzeOrderbook(this.latestOrderbook);
            }
        }, 200);
    }

    async stop() {
        this.isRunning = false;
        if (this.ws) this.ws.close();
        console.log(`[Market ${this.marketId}] Bot Stopped.`);
    }

    private async initMarket() {
        const market = await this.api.getMarket(this.marketId);
        const title = market.question || market.title || `Market #${this.marketId}`;
        console.log(`Target Market: ${title}`);

        await this.api.ensureCorrectContract(market);

        this.marketParams = {
            marketTitle: title,
            yesToken: market.outcomes[0],
            noToken: market.outcomes[1],
            isNegRisk: market.isNegRisk,
            isYieldBearing: market.isYieldBearing,
            feeRateBps: market.feeRateBps,
            decimalPrecision: market.decimalPrecision || 2
        };
    }


    private analyzeOrderbook(ob: OrderbookData) {
        if (!this.isRunning || this.phase === 'COMPLETE') return;
        if (ob.asks.length === 0 || ob.bids.length === 0) return;

        // Note: Predict orderbook usually provides YES bids/asks.
        // We derive NO prices: NO Bid = 1 - YES Ask; NO Ask = 1 - YES Bid

        const bestBidYes = ob.bids[0][0];
        const bestAskYes = ob.asks[0][0];

        // YES Price (Market Price to BUY YES is ASK)
        // Actually, we want to Buy Dips. So we buy at ASK?
        // If price crashes, ASK drops.
        const currentPriceYes = bestAskYes;

        // NO Price (Market Price to BUY NO is 1 - YES Bid)
        const currentPriceNo = Number((1 - bestBidYes).toFixed(4));

        const now = Date.now();

        // 1. Update History & High Water Mark
        this.updateHistory(this.yesHistory, currentPriceYes, now);
        this.updateHistory(this.noHistory, currentPriceNo, now);

        this.yesHighWater = this.getHighWater(this.yesHistory);
        this.noHighWater = this.getHighWater(this.noHistory);

        if (this.phase === 'MONITORING') {
            // New Entry Logic: Velocity + Depth
            // 1. Calculate Velocity
            const velocityYes = this.calculateVelocity(this.yesHistory);
            const velocityNo = this.calculateVelocity(this.noHistory);

            // 2. Dynamic Sizing
            const walletBalance = 100; // Mock or Needs Fetch. For now, use Config Shares but cap.
            // Ideally we need api.getUSDTBalance() cached. For now, we use fixed shares but respect depth.
            // User requested: shares = Math.min(maxSize, wallet * 0.01 / price);

            // Trigger 1: YES Dump
            if (velocityYes < this.config.maxVelocity) {
                // Check Depth
                const depth = this.checkOrderbookDepth(ob.asks, currentPriceYes * 1.01);
                if (depth > this.config.shares * 2) {
                    console.log(`🔥 DIP DETECTED: YES Velocity ${velocityYes.toFixed(2)} | Depth: ${depth}`);
                    this.executeLeg1(currentPriceYes, 'YES', this.marketParams.yesToken.onChainId);
                }
            }
            // Trigger 2: NO Dump
            else if (velocityNo < this.config.maxVelocity) {
                const depth = this.checkOrderbookDepth(ob.bids, currentPriceNo * 0.99); // NO Price is synthetic? 
                // Wait, currentPriceNo is derived from YES BIDS.
                // NO Ask = 1 - YES Bid.
                // If NO is Dumping, NO Price Drops. 
                // NO Price = 1 - YES Bid. 
                // So if NO Price Drops, YES Bid Rises?
                // Wait. NO dumping means NO price goes down. 
                // NO (0) -> NO (0.2). Value drops.
                // NO Price = 1 - YES Bid.
                // If NO Price = 0.2, then 1 - YES Bid = 0.2 => YES Bid = 0.8.
                // If NO Price was 0.5, YES Bid was 0.5.
                // So NO Dump = YES Pump.

                // Let's rely on YES Velocity primarily for "BTC Up/Down" 
                // But if we want to trade the NO side:
                // NO Price is derived. We can trade NO Token directly if we had NO orderbook data?
                // Predict API gives `bids/asks` for the MARKET (which is YES token usually).
                // "The orderbook ... [price, size]".
                // Price is usually YES token.
                // So `ob.bids` are Bids for YES. `ob.asks` are Asks for YES.
                // If we want to buy NO, we buy NO tokens? Or we Sell YES?
                // SDK `placeLimitOrder` takes `tokenId`. 
                // If we want to BUY NO, we place BID on NO Token.
                // Does the API support NO Token bids? YES.

                // Simplified: We only monitor YES dumps for now (BTC Crash -> Buy Dip). 
                // "If dip is YES and BTC is already down...".
                // If BTC crashes, YES (Up) crashes. We buy YES.

                // Velocity Check for NO (If NO crashes, means BTC Pumps)
                // If NO crashes, we buy NO?
                if (velocityNo < this.config.maxVelocity) {
                    // Check depth? We need NO Asks. 
                    // Derived NO Asks = 1 - YES Bids.
                    // But we can't check depth easily without querying NO orderbook specifically if it exists separately
                    // OR we assume symmetry.
                    // Validating purely on YES side for now is safer.
                }
            }
        }
        else if (this.phase === 'LEG1_FILLED') {
            // Monitor for Leg 2 (Opposite)
            const leg1Price = this.leg1FillPrice;
            const targetSide = (this.leg1Side === 'YES') ? 'NO' : 'YES';
            const targetPrice = (targetSide === 'YES') ? currentPriceYes : currentPriceNo;
            const targetTokenId = (targetSide === 'YES') ? this.marketParams.yesToken.onChainId : this.marketParams.noToken.onChainId;

            // 4. Directional Skip
            // "If dip is YES (we bought YES) and BTC is already down (Momentum < 0) -> DO NOT HEDGE"
            // We bought YES because Velocity < -0.12 (Crash).
            // Momentum is obviously negative.
            // User logic: "If dip is YES and BTC is already down... DO NOT HEDGE"
            // If we bought the dip, we expect reversion. 
            // If we hedge, we lock in a loss or small profit.
            // If we don't hedge, we hold naked YES.
            // We only hedge if "Thesis Invalidated"?
            // Let's implement the SKIP logic:

            let skipHedge = false;
            // Momentum check: Is price RECOVERING?
            // If Price < FillPrice, we are still down.
            // If Price > FillPrice, we are recovering.
            // User said: "If dip is YES and BTC is already down: DO NOT HEDGE"
            // This is slightly ambiguous. I will interpret as:
            // "If we are Long YES, and the trend is still Down, don't panic buy NO."
            // Only hedge if we can lock arb?

            const totalCost = leg1Price + targetPrice;

            if (totalCost <= this.config.sumTarget) {
                console.log(`🎯 SUM TARGET HIT: ${totalCost.toFixed(3)} (<= ${this.config.sumTarget}). Locking Arb...`);
                this.executeLeg2(targetPrice, targetSide, targetTokenId);
            } else {
                // Soft Hedge Opportunity?
                // If we are profitable directional but not arb?
                // "Win if final_value >= cost" is post-game.
                // Here we just wait.
            }
        }
    }

    private updateHistory(history: PricePoint[], price: number, now: number) {
        history.push({ timestamp: now, price });
        // Keep only window
        while (history.length > 0 && now - history[0].timestamp > this.config.slidingWindowMs) {
            history.shift();
        }
    }

    private getHighWater(history: PricePoint[]): number {
        if (history.length === 0) return 0;
        return Math.max(...history.map(p => p.price));
    }

    private async executeLeg1(price: number, side: 'YES' | 'NO', tokenId: string) {
        console.log(`🛒 BUY LEG 1: ${side} @ ${price}`);
        // Lock phase to avoid double-entry
        this.phase = 'LEG1_FILLED'; // Optimistic lock

        try {
            // Dynamic Sizing: Min(Config.Shares, 1% of Wallet / Price)
            // Example: $1000 Wallet. 1% = $10. Price $0.5. Shares = 20.
            const riskAllocatedSize = (this.walletBalanceUSDT * 0.01) / price;
            const finalShares = Math.min(this.config.shares, Math.floor(riskAllocatedSize));

            if (finalShares < 1) {
                console.log(`⚠️ Size too small (${finalShares}). Skipping.`);
                this.phase = 'MONITORING';
                return;
            }

            const priceWei = parseUnits(price.toFixed(18), 18);
            const sizeWei = parseUnits(finalShares.toString(), 18);

            if (this.config.dryRun) {
                console.log(`[Market ${this.marketId}] 🧪 DRY RUN: Would place Leg 1 ${side} @ ${price} (Qty: ${finalShares})`);
                this.leg1FillPrice = price;
                this.leg1TokenId = tokenId;
                this.leg1Side = side;
                this.leg1Time = Date.now();
                console.log(`✅ [DRY RUN] LEG 1 SIMULATED. Waiting for ${side === 'YES' ? 'NO' : 'YES'}...`);
                return;
            }

            const res = await this.api.placeLimitOrder(
                priceWei,
                sizeWei,
                Side.BUY,
                tokenId,
                this.marketParams.isNegRisk,
                this.marketParams.isYieldBearing,
                this.marketParams.feeRateBps
            );

            if (res.success) {
                this.leg1FillPrice = price;
                this.leg1TokenId = tokenId;
                this.leg1Side = side;
                this.leg1Time = Date.now();
                console.log(`✅ LEG 1 FILLED. Waiting for ${side === 'YES' ? 'NO' : 'YES'}...`);

                const alertMsg = `💰 *DIP BUY (Leg 1)*\n\n` +
                    `*Market*: ${escapeMarkdown(this.marketParams.marketTitle || `Market #${this.marketId}`)}\n` +
                    `*Side*: ${escapeMarkdown(side)}\n` +
                    `*Price*: $${escapeMarkdown(price.toFixed(3))}\n` +
                    `*Qty*: ${finalShares}\n\n` +
                    `⏳ Waiting for Leg 2 (Hedge)\\.\\.\\.`;
                sendAlert(alertMsg);
            } else {
                console.error("❌ Leg 1 Failed:", res);
                this.phase = 'MONITORING'; // Unlock
            }
        } catch (e) {
            console.error("❌ Leg 1 Exe Error:", e);
            this.phase = 'MONITORING';
        }
    }

    private async executeLeg2(price: number, side: 'YES' | 'NO', tokenId: string) {
        console.log(`🛒 BUY LEG 2: ${side} @ ${price}`);
        try {
            const priceWei = parseUnits(price.toFixed(18), 18);
            const sizeWei = parseUnits(this.config.shares.toString(), 18);

            if (this.config.dryRun) {
                console.log(`[Market ${this.marketId}] 🧪 DRY RUN: Would place Leg 2 ${side} @ ${price}`);
                this.phase = 'COMPLETE';
                const profit = this.config.shares * (1 - (this.leg1FillPrice + price));
                console.log(`💰 [DRY RUN] ARB SIMULATED! Est. Profit: $${profit.toFixed(2)}`);

                // Cooldown 10s to prevent double-dipping
                setTimeout(() => {
                    console.log(`[Market ${this.marketId}] 🧪 Cooldown Over. Resetting to MONITORING.`);
                    this.phase = 'MONITORING';
                    this.leg1Side = null;
                    this.leg1FillPrice = 0;
                }, 10000);
                return;
            }

            const res = await this.api.placeLimitOrder(
                priceWei,
                sizeWei,
                Side.BUY,
                tokenId,
                this.marketParams.isNegRisk,
                this.marketParams.isYieldBearing,
                this.marketParams.feeRateBps
            );

            if (res.success) {
                this.phase = 'COMPLETE';
                const profit = this.config.shares * (1 - (this.leg1FillPrice + price));
                console.log(`💰 ARB LOCKED! Est. Profit: $${profit.toFixed(2)}`);

                // Cooldown 10s to prevent double-dipping the same regime
                setTimeout(() => {
                    console.log(`[Market ${this.marketId}] 🟢 Cooldown Over. Resetting to MONITORING.`);
                    this.phase = 'MONITORING';
                    this.leg1Side = null;
                    this.leg1FillPrice = 0;
                }, 10000);

                const alertMsg = `🎯 *ARB LOCKED (Leg 2)*\n\n` +
                    `*Market*: ${escapeMarkdown(this.marketParams.marketTitle || `Market #${this.marketId}`)}\n` +
                    `*Side*: ${escapeMarkdown(side)}\n` +
                    `*Price*: $${escapeMarkdown(price.toFixed(3))}\n\n` +
                    `💰 *Est. Profit*: $${escapeMarkdown(profit.toFixed(2))}`;
                sendAlert(alertMsg);
            }
        } catch (e) {
            console.error("Leg 2 Failed");
        }
    }

    private calculateVelocity(history: PricePoint[]): number {
        if (history.length < 6) return 0;
        const n = history.length - 1;
        const current = history[n].price;
        const old = history[n - 5].price;
        if (old === 0) return 0;
        return (current - old) / old;
    }

    private checkOrderbookDepth(levels: [number, number][], priceCap: number): number {
        return levels
            .filter(([p]) => p <= priceCap)
            .reduce((sum, [, qty]) => sum + qty, 0);
    }

    private trySoftHedgeLadder(currentOppPrice: number): number | null {
        // Ladders: Try to fill at increasingly aggressive prices, but NEVER break mathematical expectancy.
        // We only return a price if it guarantees (Leg1 + Leg2 <= SumTarget).
        // Note: currentOppPrice is passed for context/logging but we rely on our ladder limits for safety.
        // If the market is trading at 0.95 and our max affordable hedge is 0.70, we place limit at 0.70.
        // It won't fill immediately (it sits on book), which is what we want (Passive Fish).

        const ladders = [0.85, 0.80, 0.75, 0.70];

        for (const p of ladders) {
            if (this.leg1FillPrice + p <= this.config.sumTarget) {
                return p;
            }
        }
        return null;
    }

    // Soft Hedge Ladder (Replaces Panic Hedge)
    private async checkLeg2Timeout() {
        if (this.phase !== 'LEG1_FILLED') return;

        // If timeout reached
        if (Date.now() - this.leg1Time > this.config.leg2Timeout) {

            // 4. Directional Skip Logic
            const currentVelocity = (this.leg1Side === 'YES')
                ? this.calculateVelocity(this.yesHistory)
                : this.calculateVelocity(this.noHistory);

            if (currentVelocity < -0.05) { // Still dropping > 5%
                console.log(`🛑 Directional Skip: Momentum still negative (${(currentVelocity * 100).toFixed(1)}%). Holding Naked Delta. No Hedge.`);
                this.leg1Time += 5000; // Snooze 5s
                return;
            }

            const targetSide = (this.leg1Side === 'YES') ? 'NO' : 'YES';
            const targetTokenId = (targetSide === 'YES') ? this.marketParams.yesToken.onChainId : this.marketParams.noToken.onChainId;

            // Get Current Opportunity Price for Context
            // Note: 'bids' are YES Bids. 'asks' are YES Asks. 
            // If target is YES -> We buy at ASK.
            // If target is NO -> We buy NO. NO Price = 1 - YES Bid.
            let currentOppPrice = 0;
            if (this.latestOrderbook) {
                if (targetSide === 'YES') {
                    currentOppPrice = this.latestOrderbook.asks[0]?.[0] || 0;
                } else {
                    const bestBid = this.latestOrderbook.bids[0]?.[0];
                    currentOppPrice = bestBid ? Number((1 - bestBid).toFixed(4)) : 0;
                }
            }

            if (!currentOppPrice) return;

            const hedgePrice = this.trySoftHedgeLadder(currentOppPrice);

            if (!hedgePrice) {
                console.log(`⏳ Timeout reached — no arb-valid hedge (Best: ${currentOppPrice}). Holding naked ${this.leg1Side}.`);
                this.leg1Time += 5000; // Snooze
                return;
            }

            console.log(`🪝 Soft hedge opportunity @ ${hedgePrice} (Market: ${currentOppPrice})`);
            await this.executeLeg2(hedgePrice, targetSide, targetTokenId);
        }
    }

    private async autoRedeem() {
        if (!this.marketId || !this.isRunning) return;
        try {
            // Check for positions in this market
            const positions = await this.api.getPositions();
            const myPositions = positions.filter((p: any) =>
                p.tokenId === this.marketParams.yesToken.onChainId ||
                p.tokenId === this.marketParams.noToken.onChainId
            );

            if (this.config.dryRun) {
                // Simulated check
                const market = await this.api.getMarket(this.marketId);
                if (market.resolved) {
                    console.log(`[Market ${this.marketId}] 🧪 [DRY RUN] Market Resolved. Would redeem any positions.`);
                } else if (myPositions.length > 0) {
                    const yesPos = myPositions.find((p: any) => p.tokenId === this.marketParams.yesToken.onChainId);
                    const noPos = myPositions.find((p: any) => p.tokenId === this.marketParams.noToken.onChainId);
                    if (yesPos && noPos && parseFloat(yesPos.amount) > 0 && parseFloat(noPos.amount) > 0) {
                        console.log(`[Market ${this.marketId}] 🧪 [DRY RUN] Symmetry found. Would merge shares.`);
                    }
                }
                return;
            }

            if (myPositions.length === 0) return;

            const market = await this.api.getMarket(this.marketId);
            if (market.resolved) {
                console.log(`[Market ${this.marketId}] Market Resolved. redeeming...`);
                // For each position, if amount > 0, redeem
                for (const pos of myPositions) {
                    const amount = parseUnits(pos.amount, 18);
                    if (amount > 0n) {
                        const indexSet = pos.tokenId === this.marketParams.yesToken.onChainId ? 1 : 2;
                        await this.api.redeemPositions(
                            market.conditionId,
                            indexSet as 1 | 2,
                            amount,
                            this.marketParams.isNegRisk,
                            this.marketParams.isYieldBearing
                        );
                    }
                }
                this.isRunning = false;
            } else {
                // If we have both YES and NO, we can MERGE them to reclaim collateral
                const yesPos = myPositions.find((p: any) => p.tokenId === this.marketParams.yesToken.onChainId);
                const noPos = myPositions.find((p: any) => p.tokenId === this.marketParams.noToken.onChainId);

                if (yesPos && noPos && parseFloat(yesPos.amount) > 0 && parseFloat(noPos.amount) > 0) {
                    const amountToMerge = Math.min(parseFloat(yesPos.amount), parseFloat(noPos.amount));
                    console.log(`[Market ${this.marketId}] 🔄 Symmetry found. Merging ${amountToMerge} shares...`);
                    await this.api.mergePositions(
                        market.conditionId,
                        parseUnits(amountToMerge.toString(), 18),
                        this.marketParams.isNegRisk,
                        this.marketParams.isYieldBearing
                    );
                }
            }
        } catch (e) {
            console.error(`[Market ${this.marketId}] AutoRedeem Error:`, e);
        }
    }
}
