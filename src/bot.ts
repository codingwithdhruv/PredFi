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
    private isExiting: boolean = false; // Add Exiting State
    private lastOrderTime: number = 0;

    // Internal state for current quotes
    private currentBid: number = 0;
    private currentAsk: number = 0;

    // Volatility State
    private requoteCount: number = 0;
    private lastRequoteReset: number = Date.now();
    private isTradingHalted: boolean = false; // Hard Kill Switch
    private isDumping: boolean = false; // Lock for dump routine
    private isUpdating: boolean = false; // Concurrency Lock for updateOrders

    // Monitoring State
    private lastQuotedBid: number | null = null;
    private lastQuotedAsk: number | null = null;
    private latestOrderbook: OrderbookData | null = null;
    private needsRequote: boolean = false;
    private monitorInterval: NodeJS.Timeout | null = null;

    constructor(marketId: number, existingApi?: ApiClient) {
        this.api = existingApi || new ApiClient();
        this.marketId = marketId;
        this.ws = null as any;
    }

    async start() {
        console.log(`Starting Points Farming Bot for Market ID: ${this.marketId}`);

        if (!this.api.isInitialized()) {
            await this.api.init();
        }

        try {
            console.log(`[Market ${this.marketId}] Checking approvals...`);
            await this.api.setApprovals();
            console.log(`✅ [Market ${this.marketId}] Approvals set.`);
        } catch (e) {
            console.error(`⚠️ [Market ${this.marketId}] Failed to set approvals:`, e);
        }

        console.log(`[Market ${this.marketId}] Connecting to WebSocket...`);
        const wsSocket = new WebSocket(CONFIG.WS_URL, {
            headers: { 'x-api-key': CONFIG.API_KEY }
        });
        this.ws = new RealtimeClient(wsSocket, { maxConnAttempts: 10, maxRetryInterval: 5000 });

        // Init Params & Patch SDK
        await this.initMarketParams();
        if (!this.marketParams) {
            console.error(`[Market ${this.marketId}] Failed to initialize market params. Exiting.`);
            return;
        }

        // Strict Cleanup on Start
        console.log(`[Market ${this.marketId}] 🧹 Checking for orphaned orders...`);
        await this.cancelAllOrders();
        await this.cleanupExistingPositions();

        const channel: Channel = { name: 'predictOrderbook', marketId: this.marketId };
        this.ws.subscribe(channel, (msg) => {
            if (msg.data) {
                // Update local cache immediately, logic happens in loop or on update
                this.latestOrderbook = msg.data as OrderbookData;
                this.onOrderbookUpdate(msg.data as OrderbookData);
            }
        });

        // Monitor Open Orders (Health Check)
        this.startOpenOrderMonitor();

        this.startMonitoringLoop();

        this.isRunning = true;
        console.log(`[Market ${this.marketId}] Bot is running.`);
    }

    private startOpenOrderMonitor() {
        // Periodic Health Check for Zombie Orders (10s)
        setInterval(async () => {
            if (!this.isRunning || !this.marketParams || this.isExiting || this.isTradingHalted) return;

            try {
                const orders = await this.api.getOpenOrders();
                const myOrders = orders.filter((o: any) =>
                    o.order?.maker?.toLowerCase() === this.api.getAddress().toLowerCase() &&
                    (o.order?.tokenId === this.marketParams?.yesTokenId || o.order?.tokenId === this.marketParams?.noTokenId)
                );

                if (myOrders.length > 2) {
                    console.warn(`[Market ${this.marketId}] ⚠️ ZOMBIE ALERT: Found ${myOrders.length} active orders (Expected <= 2). Force Cleaning...`);
                    await this.cancelAllOrders();
                } else if (myOrders.length > 0) {
                    // Debug log occasionally? No, keep it quiet unless error.
                }
            } catch (e) {
                console.error(`[Market ${this.marketId}] Monitor Error:`, e);
            }
        }, 10000);
    }

    private startMonitoringLoop() {
        // Lightweight 200ms loop to check for DRIFT
        this.monitorInterval = setInterval(() => {
            if (!this.isRunning || !this.marketParams || this.isExiting || this.isTradingHalted || this.isDumping || !this.latestOrderbook) return;

            const ob = this.latestOrderbook;
            if (ob.bids.length === 0 || ob.asks.length === 0) return;

            const bestBid = ob.bids[0][0];
            const bestAsk = ob.asks[0][0];
            const mid = (bestBid + bestAsk) / 2;

            // Check DRIFT from my last QUOTED price
            // 1. DANGER: Distance < MinDist (Too Close)
            // 2. STALE: Distance > MaxDist (Too Far)
            const minDist = CONFIG.MIN_DIST_FROM_MID;
            const maxDist = CONFIG.MAX_DIST_FROM_MID || 0.10;
            let driftDetected = false;
            let driftReason = "";

            if (this.lastQuotedBid !== null) {
                // Danger: Mid drops towards Bid (Mid - Bid < Min)
                // Stale: Mid rises away from Bid (Mid - Bid > Max)
                const dist = mid - this.lastQuotedBid;
                if (dist < minDist) { driftDetected = true; driftReason = "Bid Too Close"; }
                if (dist > maxDist) { driftDetected = true; driftReason = "Bid Too Far"; }
            }

            if (this.lastQuotedAsk !== null) {
                // Danger: Mid rises towards Ask (Ask - Mid < Min)
                // Stale: Mid drops away from Ask (Ask - Mid > Max)
                const dist = this.lastQuotedAsk - mid;
                if (dist < minDist) { driftDetected = true; driftReason = "Ask Too Close"; }
                if (dist > maxDist) { driftDetected = true; driftReason = "Ask Too Far"; }
            }

            if (driftDetected && !this.needsRequote) {
                console.log(`[Market ${this.marketId}] ⚠️ DRIFT (${driftReason})! Flagging Re-quote.`);
                this.needsRequote = true;
                // Force trigger update logic immediately reusing existing flow
                if (this.latestOrderbook) {
                    this.onOrderbookUpdate(this.latestOrderbook);
                }
            }
        }, 200);
    }

    private async initMarketParams() {
        try {
            const market = await this.api.getMarket(this.marketId);
            console.log(`[Market ${this.marketId}] Found: ${market.title}`);
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
        } catch (e) {
            console.error(`[Market ${this.marketId}] Error fetching details:`, e);
        }
    }

    async cancelAllOrders(): Promise<boolean> {
        // STRICT CANCELLATION: Always fetch from API
        try {
            const orders = await this.api.getOpenOrders();
            const myOrders = orders.filter((o: any) =>
                o.order?.maker?.toLowerCase() === this.api.getAddress().toLowerCase() &&
                (o.order?.tokenId === this.marketParams?.yesTokenId || o.order?.tokenId === this.marketParams?.noTokenId)
            );

            // Hybrid Check: Merge API orders with Local Active Orders to handle Lag
            const apiIds = myOrders.map((o: any) => String(o.id));
            const localIds = this.activeOrders.map(id => String(id));
            const uniqueIds = Array.from(new Set([...apiIds, ...localIds]));

            if (uniqueIds.length === 0) {
                // Truly Clean
                this.activeOrders = [];
                process.stdout.write(`[Market ${this.marketId}] 🧹 Checking status... ✅ Clean\n`);
                return false;
            }

            process.stdout.write(`[Market ${this.marketId}] 🧹 Checking status... 🛑 Dirty (${uniqueIds.length} orders). Cancelling... `);

            if (uniqueIds.length > 0) {
                await this.api.removeOrders(uniqueIds);
                process.stdout.write(`✅ Done\n`);
            }

            this.activeOrders = [];
            return true; // Had orders, cancelled them
        } catch (e) {
            console.error(`[Market ${this.marketId}] Cancel Error:`, e);
            return true; // Assume dirty if error
        }
    }

    private async cleanupExistingPositions() {
        if (!this.marketParams) return;
        console.log(`[Market ${this.marketId}] 🧹 Cleanup check...`);

        // Similar logic to before, simplified
        await this.dumpInventory();
    }

    async onOrderbookUpdate(ob: OrderbookData) {
        if (!this.isRunning || !this.marketParams || this.isExiting || this.isTradingHalted || this.isDumping) return;

        // Concurrency Lock: Skip if already running an update cycle
        if (this.isUpdating) return;
        this.isUpdating = true;

        try {
            // Volatility Kill-Switch Reset Window (10s)
            if (Date.now() - this.lastRequoteReset > 10000) {
                this.requoteCount = 0;
                this.lastRequoteReset = Date.now();
            }

            // Volatility Kill-Switch Check
            if (this.requoteCount > 5) {
                console.error(`[Market ${this.marketId}] ⚠️ KILL-SWITCH. Halting 10s...`);
                this.isTradingHalted = true;
                await this.cancelAllOrders();
                setTimeout(() => {
                    console.log(`[Market ${this.marketId}] ✅ Resuming.`);
                    this.isTradingHalted = false;
                    this.requoteCount = 0;
                }, 10000);
                return;
            }

            // TIME CHECK: Skip if too fast, UNLESS we have a pending DRIFT alert (Safety)
            if (!this.needsRequote && (Date.now() - this.lastOrderTime < CONFIG.PRICE_ADJUST_INTERVAL)) return;

            if (ob.bids.length === 0 || ob.asks.length === 0) return;

            const bestBid = ob.bids[0][0];
            const bestAsk = ob.asks[0][0];
            const mid = (bestBid + bestAsk) / 2;
            const currentSpread = bestAsk - bestBid;

            const precision = this.marketParams.decimalPrecision;
            const tickSize = 1 / Math.pow(10, precision);

            // ---------------------------------------------------------
            // Smart Liquidity Placement Logic
            // ---------------------------------------------------------

            const minDist = CONFIG.MIN_DIST_FROM_MID;

            // Calculate safe bound prices
            const maxSafeBid = mid - minDist;
            const minSafeAsk = mid + minDist;

            let targetBid = maxSafeBid;
            let targetAsk = minSafeAsk;

            // 1. Scan BIDS for a "Liquidity Wall" to join
            let foundWallBid = false;
            for (const [price, size] of ob.bids) {
                if (price <= maxSafeBid) {
                    targetBid = price;
                    foundWallBid = true;
                    break;
                }
            }

            // 2. Scan ASKS for a "Liquidity Wall" to join
            let foundWallAsk = false;
            for (const [price, size] of ob.asks) {
                if (price >= minSafeAsk) {
                    targetAsk = price;
                    foundWallAsk = true;
                    break;
                }
            }

            // 3. Fallback Snap
            targetBid = Math.floor(targetBid * Math.pow(10, precision)) / Math.pow(10, precision);
            targetAsk = Math.ceil(targetAsk * Math.pow(10, precision)) / Math.pow(10, precision);

            // Sanity: Ensure we are at least 1 tick away from mid if spread is huge
            if (targetBid >= mid) targetBid = mid - tickSize;
            if (targetAsk <= mid) targetAsk = mid + tickSize;

            // Final Snap
            targetBid = Number(targetBid.toFixed(precision));
            targetAsk = Number(targetAsk.toFixed(precision));

            // Sanity Bounds
            if (targetBid <= tickSize) targetBid = tickSize;
            if (targetAsk >= (1 - tickSize)) targetAsk = 1 - tickSize;

            // Prevent crossing the BOOK (Double Check)
            if (targetBid >= bestAsk) targetBid = bestAsk - tickSize;
            if (targetAsk <= bestBid) targetAsk = bestBid + tickSize;

            const bidDiff = Math.abs(targetBid - this.currentBid);
            const askDiff = Math.abs(targetAsk - this.currentAsk);

            // If 'needsRequote' is false, apply standard threshold check
            // If 'needsRequote' is true, we force update anyway
            if (!this.needsRequote) {
                if (bidDiff > CONFIG.REQUOTE_THRESHOLD || askDiff > CONFIG.REQUOTE_THRESHOLD) {
                    this.requoteCount++;
                    if (this.requoteCount > 2) {
                        console.log(`[Market ${this.marketId}] ⚠️ Volatility ${this.requoteCount}/5.`);
                    }
                } else {
                    return;
                }
            }

            const timestamp = new Date().toLocaleTimeString();
            console.log(`\n┌──────────────────────────────────────────────────────────┐`);
            console.log(`│ MARKET UPDATE [${timestamp}]`.padEnd(58) + `│`);
            console.log(`├──────────────────┬───────────────────┬───────────────────┤`);
            console.log(`│ Mid Price: ${mid.toFixed(3).padEnd(5)} │ Spread: ${(currentSpread * 100).toFixed(1).padStart(4)}¢ │ Safe Bid: ${maxSafeBid.toFixed(3).padEnd(5)} │`);
            console.log(`├──────────────────┴─────────┬─────────┴───────────────────┤`);
            console.log(`│ Target Bid: ${targetBid.toFixed(3).padEnd(14)} (${foundWallBid ? 'Wall' : 'Calc'}) │ Target Ask: ${targetAsk.toFixed(3).padEnd(14)} (${foundWallAsk ? 'Wall' : 'Calc'}) │`);
            console.log(`└────────────────────────────┴─────────────────────────────┘`);

            await this.updateOrders(targetBid, targetAsk);

            // UPDATE STATE
            this.currentBid = targetBid;
            this.currentAsk = targetAsk;

            // Track the Authoritative "Currently on Book" Price
            this.lastQuotedBid = targetBid;
            this.lastQuotedAsk = targetAsk;

            this.lastOrderTime = Date.now();
            this.needsRequote = false; // Reset Drift Flag
        } finally {
            this.isUpdating = false;
        }
    }



    async updateOrders(bidPrice: number, askPrice: number) {
        if (!this.marketParams || this.isTradingHalted || this.isExiting) return;

        // 1. Strict Cancel Before Replace using Blocking Pattern
        // Loop until API confirms 0 orders.
        let wasDirty = false;
        while (true) {
            const ordersFoundDirty = await this.cancelAllOrders();
            if (ordersFoundDirty) wasDirty = true;

            if (!ordersFoundDirty) break;

            console.log(`[Market ${this.marketId}] ⏳ Blocking: Orders remain. Waiting 5s before retrying...`);
            await new Promise(resolve => setTimeout(resolve, 5000));
        }

        // Safety Delay AFTER clean slate if we had to cancel
        if (wasDirty) {
            const delay = CONFIG.SAFETY_DELAY_AFTER_CANCEL || 2000;
            console.log(`[Market ${this.marketId}] 🛑 Safety Delay: Waiting ${delay}ms before placing new orders...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }

        // 2. Strict Exposure Control Check
        let currentPosYes = 0;
        let currentPosNo = 0;

        try {
            const positions = await this.api.getPositions();
            const myPositions = positions.filter((p: any) => p?.market?.id === this.marketId);
            for (const pos of myPositions) {
                const bal = parseFloat(ethers.formatUnits(pos.amount, 18));
                const isNo = pos.outcome?.name?.toUpperCase() === 'NO' || pos.outcome?.onChainId?.toLowerCase() === this.marketParams.noTokenId.toLowerCase();
                if (isNo) currentPosNo += bal;
                else currentPosYes += bal;
            }
        } catch (e) {
            console.warn(`[Market ${this.marketId}] Failed to fetch positions. Exposure check skipped.`);
        }

        const maxExposure = CONFIG.SIZE;
        const allowedYes = Math.max(0, maxExposure - currentPosYes);
        const allowedNo = Math.max(0, maxExposure - currentPosNo);

        if (allowedYes <= 1 && allowedNo <= 1) {
            console.log(`[Market ${this.marketId}] 🛑 Max Exposure Reached (${currentPosYes.toFixed(1)}/${currentPosNo.toFixed(1)}). Skipping quotes.`);
            return;
        }

        const priceYes = Number(bidPrice.toFixed(this.marketParams.decimalPrecision));
        const priceNo = Number((1 - askPrice).toFixed(this.marketParams.decimalPrecision));

        const priceYesWei = parseUnits(priceYes.toString(), 18);
        const priceNoWei = parseUnits(priceNo.toString(), 18);

        // Scale down to allowed
        const sizeYes = Math.min(CONFIG.SIZE, allowedYes);
        const sizeNo = Math.min(CONFIG.SIZE, allowedNo);

        if (sizeYes < 1 && sizeNo < 1) return;

        const promises = [];

        // Quote YES if allowed
        if (sizeYes >= 1) {
            const sizeWei = parseUnits(Math.floor(sizeYes).toString(), 18);
            promises.push(this.api.placeLimitOrder(priceYesWei, sizeWei, Side.BUY, this.marketParams.yesTokenId, this.marketParams.isNegRisk, this.marketParams.isYieldBearing, this.marketParams.feeRateBps));
        }

        // Quote NO if allowed
        if (sizeNo >= 1) {
            const sizeWei = parseUnits(Math.floor(sizeNo).toString(), 18);
            promises.push(this.api.placeLimitOrder(priceNoWei, sizeWei, Side.BUY, this.marketParams.noTokenId, this.marketParams.isNegRisk, this.marketParams.isYieldBearing, this.marketParams.feeRateBps));
        }

        try {
            process.stdout.write(`[Market ${this.marketId}] Quoting: YES@${priceYes} (x${Math.floor(sizeYes)}) | NO@${priceNo} (x${Math.floor(sizeNo)}) ... `);
            const results = await Promise.allSettled(promises);

            results.forEach((res) => {
                if (res.status === 'fulfilled' && res.value?.success) {
                    this.activeOrders.push(res.value.data.orderId);
                }
            });
            process.stdout.write(`Active: ${this.activeOrders.length}\n`);
        } catch (e) {
            console.error(`[Market ${this.marketId}] Re-quote error:`, e);
        }
    }

    private async onWalletEvent(event: PredictWalletEvents) {
        // Handle "FILL" events - TRIGGER ONLY
        if (event.type === 'orderTransactionSuccess') {
            const outcome = event.details.outcome;
            const price = parseFloat(event.details.price);
            const qtyStr = event.details.quantity;

            console.log(`\n🚨 FILL HINT: ${outcome} @ ${price} (Qty: ${qtyStr})`);
            console.log(`🛑 SETTING HARD STOP. Signaling Dump Loop...`);

            this.isExiting = true; // Block new orders
            this.isTradingHalted = true; // Hard Halt

            // Trigger dump strictly if not already running
            if (!this.isDumping) {
                this.dumpInventory(); // Fire and forget (it handles async looping)
            } else {
                console.log(`⚠️ Dump already in progress. Ignoring duplicate trigger.`);
            }
        }
    }

    private async dumpInventory() {
        if (!this.marketParams) return;
        this.isDumping = true;

        console.log(`[Market ${this.marketId}] 🧹 STARTING AUTHORITATIVE DUMP LOOP...`);

        // Hard Loop until clean
        while (true) {
            // 1. Cancel everything first to stop the bleeding
            await this.cancelAllOrders();

            // 2. Fetch authoritative state
            let positions = [];
            try {
                positions = await this.api.getPositions();
            } catch (e) {
                console.warn("API Error getting positions, retrying...");
                await new Promise(r => setTimeout(r, 1000));
                continue;
            }

            const myPositions = positions.filter((p: any) => p?.market?.id === this.marketId);

            let totalShares = 0n;
            const dustThreshold = parseUnits("0.1", 18); // 0.1 Share Dust

            for (const pos of myPositions) {
                const balanceWei = BigInt(pos.amount);
                // Only count substantial positions
                if (balanceWei > dustThreshold) {
                    totalShares += balanceWei;
                }
            }

            // BREAK CONDITION: Clean!
            if (totalShares === 0n) {
                console.log(`[Market ${this.marketId}] ✅ Inventory Clean (Shares < 0.1). Break.`);
                break;
            }

            console.log(`⚠️ Dirty Inventory Detected. Cleaning ${myPositions.length} positions...`);

            for (const pos of myPositions) {
                const balanceWei = BigInt(pos.amount);
                if (balanceWei > dustThreshold) {
                    let outcome: 'YES' | 'NO' = 'YES';
                    if (pos.outcome?.name?.toUpperCase() === 'NO' || pos.outcome?.onChainId?.toLowerCase() === this.marketParams.noTokenId.toLowerCase()) outcome = 'NO';

                    const qtyStr = ethers.formatUnits(balanceWei, 18);
                    console.log(`[Market ${this.marketId}] 🔥 DUMP: ${outcome} x ${qtyStr} ...`);

                    // Attempt execute
                    await this.exitPosition(outcome, qtyStr);
                }
            }

            // Wait for settlement/block
            console.log("⏳ Waiting 2s for confirmation...");
            await new Promise(r => setTimeout(r, 2000));
        }

        this.isDumping = false;

        // Resume after cooldown
        console.log(`[Market ${this.marketId}] ✅ Dump Loop Finished. Cooling down 5s...`);
        setTimeout(() => {
            console.log(`[Market ${this.marketId}] 🟢 Resuming Market Making.`);
            this.isExiting = false;
            this.isTradingHalted = false;
            this.requoteCount = 0;
        }, 5000);
    }

    private async exitPosition(filledOutcome: 'YES' | 'NO', quantityStr: string) {
        if (!this.marketParams) return;
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
            if (!res.success) console.error(`[Market ${this.marketId}] Exit Failed:`, JSON.stringify(res));
        } catch (e) {
            console.error(`[Market ${this.marketId}] Exit Error:`, e);
        }
    }
}

// Main Entry
export async function runBot() {
    console.log("🚀 Starting Multi-Market Bot...");
    const api = new ApiClient();
    await api.init(); // Shared API instance

    // Log Balances (once for the shared API client)
    try {
        const signer = api.getSignerAddress();
        const trader = api.getTraderAddress();
        const bnb = await api.getBNBBalance();
        const usdt = await api.getUSDTBalance();

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

    const bots: MarketMaker[] = [];

    // Bot 1
    if (CONFIG.MARKET_ID) {
        bots.push(new MarketMaker(CONFIG.MARKET_ID, api));
    }

    // Bot 2
    if (CONFIG.MARKET_ID_2) {
        bots.push(new MarketMaker(CONFIG.MARKET_ID_2, api));
    }

    if (bots.length === 0) {
        console.error("❌ No Market IDs configured.");
        return;
    }

    // Subscribe to wallet events once for the shared API client
    const wsSocket = new WebSocket(CONFIG.WS_URL, {
        headers: { 'x-api-key': CONFIG.API_KEY }
    });
    const ws = new RealtimeClient(wsSocket, { maxConnAttempts: 10, maxRetryInterval: 5000 });
    const jwt = api.getJwt();
    if (jwt) {
        const walletChannel: Channel = { name: 'predictWalletEvents', jwt };
        ws.subscribe(walletChannel, (msg) => {
            if (msg.data) {
                // Distribute wallet events to all bots
                bots.forEach(bot => bot['onWalletEvent'](msg.data as PredictWalletEvents));
            }
        });
    } else {
        console.warn("⚠️ JWT not available. Wallet events will not be received.");
    }

    // Start all
    bots.forEach(bot => bot.start());
}

if (require.main === module) {
    runBot();
}
