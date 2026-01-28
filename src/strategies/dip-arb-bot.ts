import { RealtimeClient, OrderbookData, Channel } from '../services/ws';
import { ApiClient } from '../services/api';
import { CONFIG } from '../config';
import WebSocket from 'ws';
import { Side } from '@predictdotfun/sdk';
import { parseUnits } from 'ethers';

interface PricePoint {
    timestamp: number;
    price: number;
}

interface DipArbConfig {
    dipThreshold: number;      // e.g. 0.15 (15%)
    slidingWindowMs: number;   // e.g. 3000 (3s)
    sumTarget: number;         // e.g. 0.95
    shares: number;            // shares per leg
}

export class DipArbBot {
    private api: ApiClient;
    private ws: RealtimeClient;

    private config: DipArbConfig = {
        dipThreshold: 0.15,
        slidingWindowMs: 3000,
        sumTarget: 0.95,
        shares: CONFIG.SIZE || 50
    };

    private marketId: number;
    private marketParams: any = null;
    private isRunning: boolean = false;

    // Price History Buffers
    private yesHistory: PricePoint[] = [];
    private noHistory: PricePoint[] = [];

    // State Machine
    private phase: 'MONITORING' | 'LEG1_FILLED' | 'COMPLETE' = 'MONITORING';
    private leg1FillPrice: number = 0;
    private leg1TokenId: string = "";

    constructor(marketId: number) {
        this.api = new ApiClient();
        this.marketId = marketId;
        this.ws = null as any;
    }

    async start() {
        console.log(`🚀 Starting DipArb (Gabagool) Bot for Market ID: ${this.marketId}`);
        await this.api.init();

        const wsSocket = new WebSocket(CONFIG.WS_URL, {
            headers: { 'x-api-key': CONFIG.API_KEY }
        });
        this.ws = new RealtimeClient(wsSocket, { maxConnAttempts: 10, maxRetryInterval: 5000 });

        await this.initMarket();

        const channel: Channel = { name: 'predictOrderbook', marketId: this.marketId };
        this.ws.subscribe(channel, (msg) => {
            if (msg.data) {
                this.analyzeOrderbook(msg.data as OrderbookData);
            }
        });

        this.isRunning = true;
        console.log("Monitoring price dips...");
    }

    private async initMarket() {
        const market = await this.api.getMarket(this.marketId);
        console.log(`Target Market: ${market.title}`);

        // Ensure correct contract is patched in SDK
        await this.api.ensureCorrectContract(market);

        // Outcome 0 = YES/UP, Outcome 1 = NO/DOWN
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

        // On Predict.fun, the orderbook 'asks' and 'bids' are for the YES token.
        // To get the NO token price: Price(NO) = 1 - Price(YES)
        // BUT wait, Predict.fun API for /markets/{id}/orderbook usually returns YES side.
        // Actually, some markets have NO side orderbooks too. 
        // Let's assume the provided WS data is for the YES token.

        if (ob.asks.length === 0 || ob.bids.length === 0) return;

        const yesAsk = ob.asks[0][0];
        const yesBid = ob.bids[0][0]; // To derive NO Ask: 1 - yesBid

        const noAsk = Number((1 - yesBid).toFixed(4));
        const now = Date.now();

        // 1. Update History
        this.updateHistory(this.yesHistory, yesAsk, now);
        this.updateHistory(this.noHistory, noAsk, now);

        if (this.phase === 'MONITORING') {
            // Check for Dips
            const yesDrop = this.calculateDrop(this.yesHistory, yesAsk, now);
            const noDrop = this.calculateDrop(this.noHistory, noAsk, now);

            if (yesDrop >= this.config.dipThreshold) {
                console.log(`🔥 DIP DETECTED: YES dropped ${(yesDrop * 100).toFixed(1)}%!`);
                this.executeLeg1(yesAsk, this.marketParams.yesToken.onChainId);
            } else if (noDrop >= this.config.dipThreshold) {
                console.log(`🔥 DIP DETECTED: NO dropped ${(noDrop * 100).toFixed(1)}%!`);
                this.executeLeg1(noAsk, this.marketParams.noToken.onChainId);
            }
        } else if (this.phase === 'LEG1_FILLED') {
            // Wait for Leg 2 (Opposite side)
            // If Leg 1 was YES, Leg 2 is NO
            const oppositeAsk = (this.leg1TokenId === this.marketParams.yesToken.onChainId) ? noAsk : yesAsk;
            const oppositeTokenId = (this.leg1TokenId === this.marketParams.yesToken.onChainId) ?
                this.marketParams.noToken.onChainId : this.marketParams.yesToken.onChainId;

            const totalCost = this.leg1FillPrice + oppositeAsk;

            if (totalCost <= this.config.sumTarget) {
                console.log(`🎯 TARGET REACHED: Total Cost ${totalCost.toFixed(3)} (<= ${this.config.sumTarget})`);
                this.executeLeg2(oppositeAsk, oppositeTokenId);
            }
        }
    }

    private updateHistory(history: PricePoint[], price: number, now: number) {
        history.push({ timestamp: now, price });
        // Keep 10s of data
        while (history.length > 0 && now - history[0].timestamp > 10000) {
            history.shift();
        }
    }

    private calculateDrop(history: PricePoint[], currentPrice: number, now: number): number {
        if (history.length < 2) return 0;

        // Find price closest to window offset (e.g. 3s ago)
        const targetTs = now - this.config.slidingWindowMs;
        const referencePoint = history.find(p => p.timestamp >= targetTs);

        if (!referencePoint) return 0;

        const drop = (referencePoint.price - currentPrice) / referencePoint.price;
        return drop > 0 ? drop : 0;
    }

    private async executeLeg1(price: number, tokenId: string) {
        console.log(`🛒 Buying Leg 1: ${tokenId} @ ${price}`);
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
                this.phase = 'LEG1_FILLED';
                console.log("✅ Leg 1 Filled. Waiting for Leg 2...");
            }
        } catch (e) {
            console.error("Leg 1 Execution Failed");
        }
    }

    private async executeLeg2(price: number, tokenId: string) {
        console.log(`🛒 Buying Leg 2: ${tokenId} @ ${price}`);
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
                console.log(`💰 ARB COMPLETE! Estimated Profit: $${profit.toFixed(2)}`);
                // Optionally auto-merge here
            }
        } catch (e) {
            console.error("Leg 2 Execution Failed");
        }
    }
}
