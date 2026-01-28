import { RealtimeClient, OrderbookData, Channel, PredictWalletEvents } from './services/ws';
import { ApiClient } from './services/api';
import { CONFIG } from './config';
import WebSocket from 'ws';
import { Side, AddressesByChainId, ChainId } from '@predictdotfun/sdk';
import { parseUnits, Contract, Wallet, ethers } from 'ethers';

interface MarketParams {
    yesTokenId: string;
    noTokenId: string;
    isNegRisk: boolean;
    isYieldBearing: boolean;
    feeRateBps: number;
    decimalPrecision: number;
    spreadThreshold: number; // e.g. 0.06
    shareThreshold: number;  // e.g. 50
    ctAddress: string;       // Added: The correct CT address this market uses
}

export class MarketMaker {
    private api: ApiClient;
    private ws: RealtimeClient;
    private activeOrders: string[] = [];

    private marketId: number;
    private marketParams: MarketParams | null = null;
    private isRunning: boolean = false;
    private lastOrderTime: number = 0;

    // Internal state for current quotes
    private currentBid: number = 0;
    private currentAsk: number = 0;

    constructor() {
        this.api = new ApiClient();
        this.marketId = CONFIG.MARKET_ID;
        this.ws = null as any;
    }

    async start() {
        console.log("Starting Points Farming Bot for Market ID:", this.marketId);

        await this.api.init();

        // Log Balances
        try {
            const signer = this.api.getSignerAddress();
            const trader = this.api.getTraderAddress();
            const bnb = await this.api.getBNBBalance();
            const usdt = await this.api.getUSDTBalance();

            console.log(`\n┌──────────────── BALANCE SUMMARY ────────────────┐`);
            console.log(`│ Signer (EOA): ${signer.slice(0, 10)}...${signer.slice(-8)} │`);
            console.log(`│ Trader (SMT): ${trader.slice(0, 10)}...${trader.slice(-8)} │`);
            console.log(`├─────────────────────────────────────────────────┤`);
            console.log(`│ EOA: ${Number(bnb).toFixed(4).padStart(12)} BNB (Gas)          │`);
            console.log(`│ SMT: ${Number(usdt).toFixed(2).padStart(12)} USDT (Collateral)   │`);
            console.log(`└─────────────────────────────────────────────────┘\n`);

            if (Number(usdt) < CONFIG.SIZE * 0.2) { // Rough check if even one leg fits
                console.warn("⚠️  WARNING: Trader balance is very low. Bot may fail to place orders.");
            }
        } catch (e) {
            console.error("Failed to fetch balances:", e);
        }

        console.log("Connecting to WebSocket...");
        const wsSocket = new WebSocket(CONFIG.WS_URL, {
            headers: { 'x-api-key': CONFIG.API_KEY }
        });
        this.ws = new RealtimeClient(wsSocket, { maxConnAttempts: 10, maxRetryInterval: 5000 });

        // Init Params & Patch SDK
        await this.initMarketParams();
        if (!this.marketParams) {
            console.error("Failed to initialize market params. Exiting.");
            return;
        }

        await this.cleanupExistingOrders();

        const channel: Channel = { name: 'predictOrderbook', marketId: this.marketId };
        this.ws.subscribe(channel, (msg) => {
            if (msg.data) {
                this.onOrderbookUpdate(msg.data as OrderbookData);
            }
        });

        const jwt = this.api.getJwt();
        if (jwt) {
            const walletChannel: Channel = { name: 'predictWalletEvents', jwt };
            this.ws.subscribe(walletChannel, (msg) => {
                if (msg.data) {
                    this.onWalletEvent(msg.data as PredictWalletEvents);
                }
            });
        }

        this.isRunning = true;
        console.log("Bot is running. Strategy: Yield Bearing + Exit-On-Fill.");
    }

    private async initMarketParams() {
        try {
            const market = await this.api.getMarket(this.marketId);
            console.log(`Market Found: ${market.title} (Yield Bearing: ${market.isYieldBearing})`);
            const outcomeYes = market.outcomes[0];
            const outcomeNo = market.outcomes[1];

            // 1. Ensure SDK is using correct contract and get its address
            const ctAddress = await this.api.ensureCorrectContract({
                isYieldBearing: market.isYieldBearing,
                isNegRisk: market.isNegRisk
            });


            (this as any).marketParams = {
                yesTokenId: outcomeYes.onChainId,
                noTokenId: outcomeNo.onChainId,
                isNegRisk: market.isNegRisk,
                isYieldBearing: market.isYieldBearing,
                feeRateBps: market.feeRateBps,
                decimalPrecision: market.decimalPrecision || 2,
                spreadThreshold: market.spreadThreshold,
                shareThreshold: market.shareThreshold || 50,
                ctAddress: ctAddress
            };

            console.log("Points Parameters:", JSON.stringify(this.marketParams, null, 2));
        } catch (e) {
            console.error("Error fetching market details:", e);
        }
    }

    private async cleanupExistingOrders() {
        console.log("Cleaning up existing orders...");
        const orders = await this.api.getOpenOrders();
        const myOrders = orders.filter((o: any) => o.order?.maker?.toLowerCase() === this.api.getAddress().toLowerCase());

        if (myOrders.length === 0) return;

        const ids = myOrders.map((o: any) => o.id);
        console.log(`Canceling ${ids.length} existing orders...`);
        await this.api.removeOrders(ids);
    }

    private requoteCount: number = 0;
    private lastRequoteReset: number = Date.now();
    private volatilityMultiplier: number = 0;

    async onOrderbookUpdate(ob: OrderbookData) {
        if (!this.isRunning || !this.marketParams) return;
        if (Date.now() - this.lastOrderTime < CONFIG.PRICE_ADJUST_INTERVAL) return;
        if (ob.bids.length === 0 || ob.asks.length === 0) return;

        const bestBid = ob.bids[0][0];
        const bestAsk = ob.asks[0][0];
        const mid = (bestBid + bestAsk) / 2;
        const currentSpread = bestAsk - bestBid;

        const precision = this.marketParams.decimalPrecision;
        const tickSize = 1 / Math.pow(10, precision);
        const snappedMid = Math.round(mid / tickSize) * tickSize;
        const maxThreshold = this.marketParams.spreadThreshold;

        let spreadRatio = 0.33;
        if (this.volatilityMultiplier > 0) spreadRatio = 0.49;

        const halfSpread = maxThreshold * spreadRatio;

        let targetBid = snappedMid - halfSpread;
        let targetAsk = snappedMid + halfSpread;

        targetBid = Math.ceil(targetBid * Math.pow(10, precision)) / Math.pow(10, precision);
        targetAsk = Math.floor(targetAsk * Math.pow(10, precision)) / Math.pow(10, precision);

        targetBid = Number(targetBid.toFixed(precision));
        targetAsk = Number(targetAsk.toFixed(precision));

        // Volatility Logic
        if (this.requoteCount >= 3) {
            this.volatilityMultiplier = 1;
        }

        // Sanity Checks
        if (targetBid <= tickSize) targetBid = tickSize;
        if (targetAsk >= (1 - tickSize)) targetAsk = 1 - tickSize;
        if (targetBid >= targetAsk) {
            targetBid = snappedMid - tickSize;
            targetAsk = snappedMid + tickSize;
        }

        // Prevent crossing the BOOK
        if (targetBid >= bestAsk) targetBid = bestAsk - tickSize;
        if (targetAsk <= bestBid) targetAsk = bestBid + tickSize;

        const bidDiff = Math.abs(targetBid - this.currentBid);
        const askDiff = Math.abs(targetAsk - this.currentAsk);

        if (bidDiff > CONFIG.REQUOTE_THRESHOLD || askDiff > CONFIG.REQUOTE_THRESHOLD) {
            this.requoteCount++;
            if (this.volatilityMultiplier > 0) {
                console.log(`⚠️ High Volatility Detected! Re-quote count: ${this.requoteCount}.`);
            }
        } else {
            return;
        }

        const timestamp = new Date().toLocaleTimeString();
        console.log(`\n┌──────────────────────────────────────────────────────────┐`);
        console.log(`│ MARKET UPDATE [${timestamp}]`.padEnd(58) + `│`);
        console.log(`├──────────────────┬───────────────────┬───────────────────┤`);
        console.log(`│ Mid Price: ${mid.toFixed(3).padEnd(5)} │ Spread: ${(currentSpread * 100).toFixed(1).padStart(4)}¢ │ Snapped: ${snappedMid.toFixed(3).padEnd(5)} │`);
        console.log(`├──────────────────┴─────────┬─────────┴───────────────────┤`);
        console.log(`│ Target Bid: ${targetBid.toFixed(3).padEnd(14)} │ Target Ask: ${targetAsk.toFixed(3).padEnd(14)} │`);
        console.log(`└────────────────────────────┴─────────────────────────────┘`);

        await this.updateOrders(targetBid, targetAsk);

        this.currentBid = targetBid;
        this.currentAsk = targetAsk;
        this.lastOrderTime = Date.now();
    }

    async updateOrders(bidPrice: number, askPrice: number) {
        if (!this.marketParams) return;

        // Soft remove previous
        if (this.activeOrders.length > 0) {
            await this.api.removeOrders(this.activeOrders);
            this.activeOrders = [];
        }

        // Strategy: Dual Buy (Long YES + Long NO)
        const noBidPrice = 1 - askPrice;

        const priceYes = Number(bidPrice.toFixed(this.marketParams.decimalPrecision));
        const priceNo = Number(noBidPrice.toFixed(this.marketParams.decimalPrecision));

        const priceYesStr = priceYes.toFixed(this.marketParams.decimalPrecision);
        const priceNoStr = priceNo.toFixed(this.marketParams.decimalPrecision);

        const priceYesWei = parseUnits(priceYesStr, 18);
        const priceNoWei = parseUnits(priceNoStr, 18);

        // Dynamic Sizing: Scale down to fit balance
        let size = CONFIG.SIZE;
        try {
            const balanceStr = await this.api.getUSDTBalance();
            const balance = parseFloat(balanceStr);

            // We need enough for BOTH legs (YES and NO) if they are placed as separate orders
            // Total USDT needed roughly: size * (priceYes + priceNo) + fees
            const totalRequiredPerShare = priceYes + priceNo;
            const maxAffordableSize = (balance * 0.95) / totalRequiredPerShare; // 5% buffer for fees

            if (size > maxAffordableSize) {
                size = Math.floor(maxAffordableSize * 100) / 100;
                if (size > 0) {
                    console.log(`⚠️  Balancing: Scaling size down from ${CONFIG.SIZE} to ${size} to fit ${balance.toFixed(2)} USDT balance.`);
                }
            }
        } catch (e) {
            console.warn("Failed to check balance for sizing, using default.");
        }

        if (size <= 0) {
            console.warn("❌ SKIP: Insufficient balance to place even the smallest order.");
            return;
        }

        const sizeWei = parseUnits(size.toString(), 18);

        try {
            process.stdout.write(`📡 Re-quoting: [YES @ ${priceYes.toFixed(3)}] [NO @ ${priceNo.toFixed(3)}] size=${size} ... `);
            const results = await Promise.allSettled([
                this.api.placeLimitOrder(priceYesWei, sizeWei, Side.BUY, this.marketParams.yesTokenId, this.marketParams.isNegRisk, this.marketParams.isYieldBearing, this.marketParams.feeRateBps),
                this.api.placeLimitOrder(priceNoWei, sizeWei, Side.BUY, this.marketParams.noTokenId, this.marketParams.isNegRisk, this.marketParams.isYieldBearing, this.marketParams.feeRateBps)
            ]);

            results.forEach((res, index) => {
                const token = index === 0 ? 'YES' : 'NO';
                if (res.status === 'fulfilled') {
                    if (res.value && res.value.success) {
                        this.activeOrders.push(res.value.data.orderId);
                    } else if (res.value && res.value.error?._tag === 'InsufficientCollateral') {
                        // Already logged in ApiClient
                    } else {
                        console.error(`\n❌ [${token}] Order failed:`, JSON.stringify(res.value));
                    }
                } else {
                    console.error(`\n❌ [${token}] Order failed:`, res.reason?.message || res.reason);
                }
            });
            process.stdout.write(`DONE (Active: ${this.activeOrders.length})\n`);
        } catch (e) {
            console.error("\nRe-quote wrapper failed:", e);
        }
    }

    private async onWalletEvent(event: PredictWalletEvents) {
        // Handle "FILL" events - EMERGENCY EXIT
        if (event.type === 'orderTransactionSuccess') {
            const outcome = event.details.outcome; // 'YES' or 'NO'
            const price = parseFloat(event.details.price);
            const qtyStr = event.details.quantity; // "10.0"

            const timestamp = new Date().toLocaleTimeString();
            console.log(`\n🚨🚨🚨 FILL ALERT [${timestamp}] 🚨🚨🚨`);
            console.log(`┌──────────────────────────────────────────────────┐`);
            console.log(`│ OUTCOME: ${outcome.padEnd(39)} │`);
            console.log(`│ PRICE:   ${price.toFixed(3).padEnd(39)} │`);
            console.log(`│ QTY:     ${qtyStr.padEnd(39)} │`);
            console.log(`└──────────────────────────────────────────────────┘`);
            console.log("🛑 Canceling ALL orders and Exiting Position immediately...");

            // 1. Cancel everything first to stop bleeding
            await this.api.removeOrders(this.activeOrders);
            this.activeOrders = [];

            // 2. Exit (Sell Back)
            await this.exitPosition(outcome, qtyStr);

            // 3. Reset state
            this.currentBid = 0;
            this.currentAsk = 0;
            this.requoteCount = 0;
        }
    }

    private async exitPosition(filledOutcome: 'YES' | 'NO', quantityStr: string) {
        if (!this.marketParams) return;

        console.log(`EXIT: Selling ${quantityStr} of ${filledOutcome} via Market Order (DUMP)...`);

        const tokenIdToSell = filledOutcome === 'YES' ? this.marketParams.yesTokenId : this.marketParams.noTokenId;
        const sizeWei = parseUnits(quantityStr, 18);

        try {
            const res = await this.api.placeMarketOrder(
                sizeWei,
                Side.SELL,
                tokenIdToSell,
                this.marketId,
                this.marketParams.isNegRisk,
                this.marketParams.isYieldBearing,
                this.marketParams.feeRateBps
            );

            if (res.success) {
                console.log("✅ Exit Order placed successfully (ID: " + res.data.orderId + ")");
            } else {
                console.error("❌ Exit Order failed!", JSON.stringify(res));
            }
        } catch (e) {
            console.error("Critical error during exit:", e);
        }
    }
}
