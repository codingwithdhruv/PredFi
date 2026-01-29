import { RealtimeClient, OrderbookData, Channel } from '../services/ws';
import { ApiClient } from '../services/api';
import { CONFIG } from '../config';
import WebSocket from 'ws';
import { Side } from '@predictdotfun/sdk';
import { parseUnits, ethers } from 'ethers';

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
        sumTarget: CONFIG.DIP_SUM_TARGET, // 0.95
        shares: CONFIG.DIP_SHARES, // 50
        leg2Timeout: CONFIG.DIP_LEG2_TIMEOUT_MS // 60s
    };

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

    constructor(marketId: number) {
        this.api = new ApiClient();
        this.marketId = marketId;
        this.ws = null as any;
    }

    async start() {
        console.log(`🚀 Starting DipArb (Gabagool) Bot`);
        console.log(`⚙️ Config: Threshold=${this.config.dipThreshold * 100}%, Sum<=${this.config.sumTarget}, Size=${this.config.shares}, Timeout=${this.config.leg2Timeout / 1000}s`);

        await this.api.init();

        const wsSocket = new WebSocket(CONFIG.WS_URL, {
            headers: { 'x-api-key': CONFIG.API_KEY }
        });
        this.ws = new RealtimeClient(wsSocket, { maxConnAttempts: 10, maxRetryInterval: 5000 });

        await this.initMarket();

        const channel: Channel = { name: 'predictOrderbook', marketId: this.marketId };
        this.ws.subscribe(channel, (msg) => {
            if (msg.data) {
                // Store latest immediately
                this.latestOrderbook = msg.data as OrderbookData;
                this.analyzeOrderbook(msg.data as OrderbookData);
            }
        });

        this.startMonitoringLoop();

        this.isRunning = true;
        console.log(`[Market ${this.marketId}] Monitoring price dips...`);

        // Safety Loop for Leg 2 Timeout
        setInterval(() => this.checkLeg2Timeout(), 1000);
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
        console.log(`Target Market: ${market.title}`);

        await this.api.ensureCorrectContract(market);

        this.marketParams = {
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
            // Check for Dips (Drop from High Water Mark)
            const yesDrop = (this.yesHighWater - currentPriceYes) / this.yesHighWater;
            const noDrop = (this.noHighWater - currentPriceNo) / this.noHighWater;

            if (yesDrop >= this.config.dipThreshold) {
                console.log(`🔥 DIP: YES dropped ${(yesDrop * 100).toFixed(1)}% (${this.yesHighWater} -> ${currentPriceYes})`);
                this.executeLeg1(currentPriceYes, 'YES', this.marketParams.yesToken.onChainId);
            } else if (noDrop >= this.config.dipThreshold) {
                console.log(`🔥 DIP: NO dropped ${(noDrop * 100).toFixed(1)}% (${this.noHighWater} -> ${currentPriceNo})`);
                this.executeLeg1(currentPriceNo, 'NO', this.marketParams.noToken.onChainId);
            }
        }
        else if (this.phase === 'LEG1_FILLED') {
            // Monitor for Leg 2 (Opposite)
            const leg1Price = this.leg1FillPrice;
            const targetSide = (this.leg1Side === 'YES') ? 'NO' : 'YES';
            const targetPrice = (targetSide === 'YES') ? currentPriceYes : currentPriceNo;
            const targetTokenId = (targetSide === 'YES') ? this.marketParams.yesToken.onChainId : this.marketParams.noToken.onChainId;

            const totalCost = leg1Price + targetPrice;

            if (totalCost <= this.config.sumTarget) {
                console.log(`🎯 SUM TARGET: ${totalCost.toFixed(3)} (<= ${this.config.sumTarget}). Executing Leg 2...`);
                this.executeLeg2(targetPrice, targetSide, targetTokenId);
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
            const priceWei = parseUnits(price.toFixed(18), 18);
            const sizeWei = parseUnits(this.config.shares.toString(), 18);

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
                // TODO: Auto-merge
            }
        } catch (e) {
            console.error("Leg 2 Failed");
        }
    }

    // Safety Force Hedge
    private async checkLeg2Timeout() {
        if (this.phase !== 'LEG1_FILLED') return;

        if (Date.now() - this.leg1Time > this.config.leg2Timeout) {
            console.log(`⏰ LEG 2 TIMEOUT (${this.config.leg2Timeout}ms). FORCE HEDGING...`);
            // Force buy opposite side at MARKET price (taker)
            // Or limit at current best ask if we want to be nicer? 
            // Gabagool implies "Market Order" for safety.

            // NOTE: api.placeMarketOrder isn't fully robust yet, let's use Limit at 1.0 (effectively market) or best ask + slip.
            // For safety, let's try to get out.
            const targetSide = (this.leg1Side === 'YES') ? 'NO' : 'YES';
            const targetTokenId = (targetSide === 'YES') ? this.marketParams.yesToken.onChainId : this.marketParams.noToken.onChainId;

            console.log(`🚑 FORCE BUYING ${targetSide} to close delta.`);
            await this.executeLeg2(0.99, targetSide, targetTokenId); // Paying max price just to fill
        }
    }
}
