import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { CONFIG } from '../config';
import { OrderBuilder, ChainId, Side } from '@predictdotfun/sdk';

export class ApiClient {
    public client: AxiosInstance;
    private wallet: ethers.Wallet;
    public orderBuilder: OrderBuilder | null = null;
    private jwtToken: string | null = null;

    constructor() {
        this.client = axios.create({
            baseURL: CONFIG.API_BASE_URL,
            headers: {
                'x-api-key': CONFIG.API_KEY,
                'Content-Type': 'application/json',
            },
        });
        this.wallet = new ethers.Wallet(CONFIG.PRIVATE_KEY);
    }

    // Helper to check init status
    public isInitialized(): boolean {
        return this.orderBuilder !== null && this.jwtToken !== null;
    }

    public getJwt(): string | null {
        return this.jwtToken;
    }

    async init() {
        if (this.isInitialized()) return;
        try {
            console.log("Initializing ApiClient...");
            console.log("EOA Address:", this.wallet.address);
            console.log("Predict Account:", CONFIG.PREDICT_ACCOUNT);

            // 1. Initialize OrderBuilder
            // "This should only be done once per signer"
            // "Include the predictAccount address... known as the deposit address"
            this.orderBuilder = await OrderBuilder.make(CONFIG.CHAIN_ID as ChainId, this.wallet as any, {
                predictAccount: CONFIG.PREDICT_ACCOUNT
            });

            // 2. Authenticate
            await this.authenticate();

        } catch (error: any) {
            console.error('Initialization failed:', error.response?.data || error.message);
            throw error;
        }
    }

    private async authenticate() {
        let attempts = 0;
        const maxAttempts = 5;
        const delay = 5000;

        while (attempts < maxAttempts) {
            try {
                attempts++;
                console.log(`Getting auth message (Attempt ${attempts}/${maxAttempts})...`);
                const msgRes = await this.client.get('/v1/auth/message');
                const message = msgRes.data.data.message;
                console.log("Message to sign:", message);

                let signature: string;
                let signerAddress: string;

                if (CONFIG.PREDICT_ACCOUNT) {
                    console.log("Signing for Predict Account...");
                    if (!this.orderBuilder) throw new Error("OrderBuilder not ready");
                    signature = await this.orderBuilder.signPredictAccountMessage(message);
                    signerAddress = CONFIG.PREDICT_ACCOUNT;
                } else {
                    console.log("Signing for EOA...");
                    signature = await this.wallet.signMessage(message);
                    signerAddress = this.wallet.address;
                }

                console.log("Signature generated. Sending auth request...");

                const authRes = await this.client.post('/v1/auth', {
                    signer: signerAddress,
                    message,
                    signature,
                });

                this.jwtToken = authRes.data.data.token;
                this.client.defaults.headers.common['Authorization'] = `Bearer ${this.jwtToken}`;
                console.log("✅ Authenticated successfully. JWT Token obtained.");
                return;

            } catch (error: any) {
                const status = error.response?.status;
                const errorBody = error.response?.data;
                console.warn(`⚠️ Authentication attempt ${attempts} failed (Status: ${status}).`);

                if (status === 502 || status === 503 || status === 504) {
                    if (attempts < maxAttempts) {
                        console.log(`🔄 Retrying in ${delay / 1000}s...`);
                        await new Promise(r => setTimeout(r, delay));
                        continue;
                    }
                }

                console.error("Authentication failed:", errorBody || error.message);
                throw error;
            }
        }
    }

    async getMarketOrderBook(marketId: number) {
        const res = await this.client.get(`/v1/markets/${marketId}/orderbook`);
        return res.data.data;
    }

    async placeMarketOrder(
        quantityWei: bigint,
        side: Side,
        tokenId: string,
        marketId: number,
        isNegRisk: boolean = false,
        isYieldBearing: boolean = false,
        feeRateBps: number = 0
    ) {
        if (!this.orderBuilder) throw new Error("OrderBuilder not initialized");

        try {
            // 1. Fetch Orderbook
            const orderbook = await this.getMarketOrderBook(marketId);

            console.log(`DEBUG: placeMarketOrder - Side: ${side}, QtyWei: ${quantityWei}, Bids: ${orderbook.bids.length}, Asks: ${orderbook.asks.length}`);
            if (orderbook.bids.length > 0) console.log(`DEBUG: Best Bid: ${orderbook.bids[0][0]}, Size: ${orderbook.bids[0][1]}`);
            if (orderbook.asks.length > 0) console.log(`DEBUG: Best Ask: ${orderbook.asks[0][0]}, Size: ${orderbook.asks[0][1]}`);

            // 2. Calculate Order Amounts
            const { makerAmount, takerAmount, pricePerShare } = this.orderBuilder.getMarketOrderAmounts(
                {
                    side,
                    quantityWei
                },
                orderbook
            );

            console.log(`Market Order Calc: Maker=${makerAmount.toString()} Taker=${takerAmount.toString()} Price=${pricePerShare.toString()}`);

            // 3. Build Order
            const order = this.orderBuilder.buildOrder("MARKET", {
                side,
                tokenId,
                makerAmount,
                takerAmount,
                nonce: 0n,
                feeRateBps,
            });

            // 4. Sign Order
            const typedData = this.orderBuilder.buildTypedData(order, { isNegRisk, isYieldBearing });
            const signedOrder = await this.orderBuilder.signTypedDataOrder(typedData);
            const hash = this.orderBuilder.buildTypedDataHash(typedData);

            // 5. Submit
            const body = {
                data: {
                    order: { ...signedOrder, hash },
                    pricePerShare: pricePerShare.toString(),
                    strategy: 'MARKET',
                },
            };

            const res = await this.client.post('/v1/orders', body);
            return res.data;

        } catch (error: any) {
            const errorData = error.response?.data;
            console.error('Error placing MARKET order:', JSON.stringify(errorData, null, 2) || error.message);
            throw error;
        }
    }

    async placeLimitOrder(
        pricePerShareWei: bigint,
        quantityWei: bigint,
        side: Side,
        tokenId: string,
        isNegRisk: boolean = false,
        isYieldBearing: boolean = false,
        feeRateBps: number = 0
    ) {
        if (!this.orderBuilder) throw new Error("OrderBuilder not initialized");

        try {
            // Safety Check
            if (side === Side.BUY) {
                const balanceStr = await this.getUSDTBalance();
                const balanceWei = ethers.parseUnits(balanceStr, 18);
                // Approx check, SDK handles exact
            }

            const { makerAmount, takerAmount, pricePerShare } = this.orderBuilder.getLimitOrderAmounts({
                side,
                pricePerShareWei,
                quantityWei,
            });

            if (side === Side.BUY) {
                const balanceStr = await this.getUSDTBalance();
                const balanceWei = ethers.parseUnits(balanceStr, 18);
                if (balanceWei < makerAmount) {
                    console.warn(`⚠️ Insufficient Funds: Have ${balanceStr}, Need ${ethers.formatUnits(makerAmount, 18)}`);
                    return { success: false, error: { _tag: 'InsufficientCollateral', message: 'Balance too low' } };
                }
            }

            // Build Order
            const order = this.orderBuilder.buildOrder("LIMIT", {
                side,
                tokenId,
                makerAmount,
                takerAmount,
                nonce: 0n,
                feeRateBps,
            });

            // Sign Order
            const typedData = this.orderBuilder.buildTypedData(order, { isNegRisk, isYieldBearing });
            const signedOrder = await this.orderBuilder.signTypedDataOrder(typedData);
            const hash = this.orderBuilder.buildTypedDataHash(typedData);

            // Submit
            const body = {
                data: {
                    order: { ...signedOrder, hash },
                    pricePerShare: pricePerShare.toString(),
                    strategy: 'LIMIT',
                },
            };

            const res = await this.client.post('/v1/orders', body);
            return res.data;

        } catch (error: any) {
            const errorData = error.response?.data;
            if (errorData?.error?._tag === 'CollateralPerMarketExceededError') {
                console.error(`❌ COLLATERAL ERROR: Available balance (${ethers.formatUnits(errorData.error.amountAvailable, 18)} USDT) is less than the required amount.`);
            } else {
                console.error('Error placing order:', JSON.stringify(errorData, null, 2) || error.message);
            }
            throw error;
        }
    }

    async getOpenOrders() {
        try {
            const res = await this.client.get('/v1/orders');
            return res.data.data;
        } catch (e: any) {
            console.error(`[API] getOpenOrders Error:`, e.response?.data || e.message);
            throw e;
        }
    }

    async removeOrders(orderIds: string[]) {
        try {
            const res = await this.client.post('/v1/orders/remove', { data: { ids: orderIds } });

            if (res.data?.success === false) {
                console.error(`[API] Remove Orders Failed:`, JSON.stringify(res.data));
                throw new Error(`Remove Orders Failed: ${res.data?.error || 'Unknown'}`);
            }

            return res.data;
        } catch (e: any) {
            console.error(`[API] Remove Orders Exception:`, e.response?.data || e.message);
            throw e;
        }
    }

    async getUSDTBalance(): Promise<string> {
        if (!this.orderBuilder) throw new Error("OrderBuilder not initialized");
        const bal = await this.orderBuilder.balanceOf();
        return ethers.formatUnits(bal, 18);
    }

    // Helper to get raw balance for gas check if needed
    async getBNBBalance(): Promise<string> {
        const provider = new ethers.JsonRpcProvider('https://bsc-dataseed.bnbchain.org/');
        const balance = await provider.getBalance(this.wallet.address);
        return ethers.formatEther(balance);
    }



    async getActivity(limit: number = 50): Promise<any[]> {
        try {
            const res = await this.client.get(`/v1/account/activity`, {
                params: { first: limit }
            });
            return res.data.data || [];
        } catch (e: any) {
            return [];
        }
    }

    private allActiveMarketsCache: any[] | null = null;
    private lastMarketFetch = 0;
    private readonly CACHE_TTL = 2 * 60 * 1000; // 2 minutes
    private categoryCache = new Map<string, any>();

    async getCategory(slug: string) {
        if (this.categoryCache.has(slug)) return this.categoryCache.get(slug);
        try {
            const res = await this.client.get(`/v1/categories/${slug}`);
            const cat = res.data.data;
            this.categoryCache.set(slug, cat);
            return cat;
        } catch (e) {
            return null;
        }
    }

    async searchMarkets(query: string) {
        // Fetch all active markets if cache is stale
        if (!this.allActiveMarketsCache || (Date.now() - this.lastMarketFetch) > this.CACHE_TTL) {
            console.log("🔄 Refreshing active markets cache for search...");
            const allActive: any[] = [];
            let cursor: string | null = null;
            let hasMore = true;

            while (hasMore) {
                const res = await this.getMarkets(100, cursor);
                if (!res || !res.success) break;

                const batch = res.data || [];
                if (batch.length === 0) break;

                // Only keep non-resolved markets
                const activeBatch = batch.filter((m: any) => m.status !== 'RESOLVED');
                allActive.push(...activeBatch);

                cursor = res.cursor;
                if (!cursor || batch.length < 100) hasMore = false;
                if (allActive.length > 5000) break; // Safety
            }
            this.allActiveMarketsCache = allActive;
            this.lastMarketFetch = Date.now();
            console.log(`✅ Cached ${allActive.length} active markets.`);
        }

        const normalizedQuery = query.toLowerCase();
        const searchWords = normalizedQuery.split(/[^a-z0-9]/).filter(w => w.length > 1);

        // Filter locally for better accuracy
        const matches = this.allActiveMarketsCache.filter(m => {
            const title = (m.question || m.title || "").toLowerCase();
            const id = String(m.id);
            const slug = (m.categorySlug || "").toLowerCase();
            const desc = (m.description || "").toLowerCase();
            const combined = `${title} ${id} ${slug} ${desc}`;

            // If query is strictly numeric, check ID exact match
            if (/^\d+$/.test(normalizedQuery) && id === normalizedQuery) return true;

            // Otherwise, check if all search words are present in the combined string
            return searchWords.every(word => combined.includes(word));
        });

        // Group by categorySlug
        const groupsMap = new Map<string, any[]>();
        for (const m of matches) {
            const slug = m.categorySlug || 'uncategorized';
            if (!groupsMap.has(slug)) groupsMap.set(slug, []);
            groupsMap.get(slug)!.push(m);
        }

        // Sort groups by total volume and return as list
        const groups = Array.from(groupsMap.entries()).map(([slug, markets]) => {
            const firstMarket = markets[0];
            let title = firstMarket.question || firstMarket.title || slug;

            // If the title is just a number range or too short, use the slug as the name
            if (/^\d+([-\s]\d+)?(\+)?$/.test(title) || title.length < 5) {
                title = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            }

            return {
                slug,
                title,
                markets: markets.sort((a, b) => (a.questionIndex || 0) - (b.questionIndex || 0))
            };
        });

        return groups.sort((a, b) => {
            const volA = a.markets.reduce((sum, m) => sum + (m.stats?.volume24hUsd || 0), 0);
            const volB = b.markets.reduce((sum, m) => sum + (m.stats?.volume24hUsd || 0), 0);
            return volB - volA;
        }).slice(0, 10);
    }

    getAddress(): string {
        return CONFIG.PREDICT_ACCOUNT || this.wallet.address;
    }

    getSignerAddress(): string {
        return this.wallet.address;
    }

    getTraderAddress(): string {
        return CONFIG.PREDICT_ACCOUNT || this.wallet.address;
    }

    async redeemPositions(conditionId: string, indexSet: 1 | 2, amount: bigint, isNegRisk: boolean, isYieldBearing: boolean) {
        if (!this.orderBuilder) throw new Error("OrderBuilder not initialized");

        console.log(`Redeeming positions for condition ${conditionId}...`);
        const res = await this.orderBuilder.redeemPositions({
            conditionId,
            indexSet,
            amount, // required for NegRisk
            isNegRisk,
            isYieldBearing
        });

        return res;
    }

    async mergePositions(conditionId: string, amount: bigint, isNegRisk: boolean, isYieldBearing: boolean) {
        if (!this.orderBuilder) throw new Error("OrderBuilder not initialized");

        console.log(`Merging ${ethers.formatUnits(amount, 18)} positions for condition ${conditionId}...`);
        const res = await this.orderBuilder.mergePositions({
            conditionId,
            amount,
            isNegRisk,
            isYieldBearing
        });

        return res;
    }

    async splitPositions(conditionId: string, amount: bigint, isNegRisk: boolean, isYieldBearing: boolean) {
        if (!this.orderBuilder) throw new Error("OrderBuilder not initialized");

        console.log(`Splitting ${ethers.formatUnits(amount, 18)} collateral to positions for condition ${conditionId}...`);
        const res = await this.orderBuilder.splitPositions({
            conditionId,
            amount,
            isNegRisk,
            isYieldBearing
        });

        return res;
    }

    async getAccount() {
        const res = await this.client.get('/v1/account');
        return res.data.data;
    }

    async setApprovals() {
        if (!this.orderBuilder) throw new Error("OrderBuilder not initialized");
        return await this.orderBuilder.setApprovals();
    }

    async getPositions() {
        try {
            const res = await this.client.get('/v1/positions');
            return res.data.data;
        } catch (e: any) {
            console.error("Failed to fetch positions from API:", e.response?.data || e.message);
            return [];
        }
    }

    async getMarkets(limit: number = 100, cursor: string | null = null) {
        const res = await this.client.get('/v1/markets', {
            params: {
                first: limit,
                after: cursor
            }
        });
        return res.data; // Returns { success: boolean, data: Market[], cursor: string }
    }

    async getMarketStats(marketId: number) {
        try {
            const res = await this.client.get(`/v1/markets/${marketId}/stats`);
            return res.data.data;
        } catch (e: any) {
            // Return zeroes if stats fail (e.g. 404)
            return { volume24hUsd: 0, volumeTotalUsd: 0, totalLiquidityUsd: 0 };
        }
    }

    private marketCache = new Map<number, any>();

    async getMarket(marketId: number) {
        if (this.marketCache.has(marketId)) return this.marketCache.get(marketId);
        try {
            const res = await this.client.get(`/v1/markets/${marketId}`);
            const mkt = res.data.data;
            this.marketCache.set(marketId, mkt);
            return mkt;
        } catch (e) {
            return null;
        }
    }

    async getEnrichedOpenOrders() {
        const orders = await this.getOpenOrders();
        const enriched = [];

        for (const orderItem of orders) {
            const ord = orderItem.order || orderItem;
            const mktId = orderItem.marketId || ord.marketId;

            if (mktId) {
                const market = await this.getMarket(mktId);
                const enrichedItem = { ...orderItem, market };

                // Find outcome name from tokenId
                if (market && market.outcomes && ord.tokenId) {
                    const outcome = market.outcomes.find((o: any) => o.tokenId === ord.tokenId);
                    enrichedItem.outcome = outcome;
                }
                enriched.push(enrichedItem);
            } else {
                enriched.push(orderItem);
            }
        }
        return enriched;
    }

    async getMatchEvents(limit: number = 50) {
        try {
            // Updated endpoint based on docs: /v1/orders/match-events
            const signer = CONFIG.PREDICT_ACCOUNT || this.wallet.address;
            const res = await this.client.get('/v1/orders/match-events', {
                params: { first: limit, signer }
            });
            return res.data.data || [];
        } catch (e: any) {
            // Fallback: If 404, try /v1/orders/matches
            try {
                const signer = CONFIG.PREDICT_ACCOUNT || this.wallet.address;
                const res = await this.client.get('/v1/orders/matches', { params: { first: limit, signer } });
                return res.data.data || [];
            } catch (e2) {
                return [];
            }
        }
    }

    async getVolumeStats(): Promise<{ today: number, week: number }> {
        try {
            // Fetch more activities for a more accurate volume (farming bots generate many events)
            const activities = await this.getActivity(1000);

            const now = new Date().getTime();
            const oneDayAgo = now - (24 * 60 * 60 * 1000);
            const oneWeekAgo = now - (7 * 24 * 60 * 60 * 1000);

            let today = 0;
            let week = 0;

            for (const act of activities) {
                const type = act.name || act.type || "";
                const upperType = type.toUpperCase();
                const isVolumeEvent = ['MATCH', 'TRADE', 'ORDER_MATCH', 'ORDER_FILLED', 'FILL', 'CONVERSION'].includes(upperType);

                if (isVolumeEvent) {
                    const val = parseFloat(act.valueUsd || act.value || '0');
                    const time = new Date(act.createdAt).getTime();

                    if (time >= oneDayAgo) today += val;
                    if (time >= oneWeekAgo) week += val;
                }
            }

            // Also check match events if activities missed some
            const matches = await this.getMatchEvents(100);
            for (const match of matches) {
                const val = parseFloat(match.valueUsd || match.value || '0');
                const time = new Date(match.executedAt || match.createdAt).getTime();

                // Avoid double counting by ID
                const isDuplicate = activities.some(a => a.id === match.id);
                if (!isDuplicate) {
                    if (time >= oneDayAgo) today += val;
                    if (time >= oneWeekAgo) week += val;
                }
            }

            return { today: Math.round(today * 100) / 100, week: Math.round(week * 100) / 100 };
        } catch (e) {
            return { today: 0, week: 0 };
        }
    }


    async ensureCorrectContract(market: { isYieldBearing: boolean; isNegRisk: boolean }): Promise<string> {
        if (!this.orderBuilder || !this.orderBuilder.contracts || !this.orderBuilder.contracts.CONDITIONAL_TOKENS) {
            throw new Error("OrderBuilder not initialized");
        }

        const ct = this.orderBuilder.contracts.CONDITIONAL_TOKENS.contract;
        const ctAddress = await (ct as any).getAddress();
        const chainId = CONFIG.CHAIN_ID as ChainId;

        const { AddressesByChainId } = require('@predictdotfun/sdk');
        const sdkAddresses = AddressesByChainId[chainId];

        let correctContractAddress = sdkAddresses.CONDITIONAL_TOKENS;

        if (market.isYieldBearing) {
            if (market.isNegRisk) {
                correctContractAddress = sdkAddresses.YIELD_BEARING_NEG_RISK_CONDITIONAL_TOKENS;
            } else {
                correctContractAddress = sdkAddresses.YIELD_BEARING_CONDITIONAL_TOKENS;
            }
        } else {
            if (market.isNegRisk) {
                correctContractAddress = sdkAddresses.NEG_RISK_CONDITIONAL_TOKENS;
            }
        }

        if (ctAddress.toLowerCase() !== correctContractAddress.toLowerCase()) {
            console.log(`⚠️  Patching SDK with correct CT Address: ${correctContractAddress}`);
            const runner = (ct as any).runner;
            const iface = ct.interface;

            this.orderBuilder.contracts.CONDITIONAL_TOKENS.contract = new ethers.Contract(
                correctContractAddress,
                iface as any,
                runner
            ) as any;
        }

        return correctContractAddress;
    }
}
