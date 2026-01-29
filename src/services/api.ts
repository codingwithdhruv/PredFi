import axios, { AxiosInstance } from 'axios';
import { ethers } from 'ethers';
import { CONFIG } from '../config';
import { OrderBuilder, ChainId, Side } from '@predictdotfun/sdk';

export class ApiClient {
    private client: AxiosInstance;
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
        try {
            console.log("Getting auth message...");
            const msgRes = await this.client.get('/v1/auth/message');
            const message = msgRes.data.data.message;
            console.log("Message to sign:", message);

            let signature: string;
            let signerAddress: string;

            if (CONFIG.PREDICT_ACCOUNT) {
                console.log("Signing for Predict Account...");
                // "The standard `signMessage` won't work" -> Use SDK helper
                if (!this.orderBuilder) throw new Error("OrderBuilder not ready");

                signature = await this.orderBuilder.signPredictAccountMessage(message);
                signerAddress = CONFIG.PREDICT_ACCOUNT;
            } else {
                console.log("Signing for EOA...");
                signature = await this.wallet.signMessage(message);
                signerAddress = this.wallet.address;
            }

            console.log("Signature generated:", signature);
            console.log("Sending auth request for signer:", signerAddress);

            const authRes = await this.client.post('/v1/auth', {
                signer: signerAddress,
                message,
                signature,
            });

            this.jwtToken = authRes.data.data.token;
            this.client.defaults.headers.common['Authorization'] = `Bearer ${this.jwtToken}`;
            console.log("✅ Authenticated successfully. JWT Token obtained.");

        } catch (error: any) {
            console.error("Authentication failed:", error.response?.data || error.message);
            throw error;
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
        const res = await this.client.get('/v1/orders');
        return res.data.data;
    }

    async removeOrders(orderIds: string[]) {
        const res = await this.client.post('/v1/orders/remove', { data: { ids: orderIds } });
        return res.data;
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



    async getMarket(marketId: number) {
        const res = await this.client.get(`/v1/markets/${marketId}`);
        return res.data.data;
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
