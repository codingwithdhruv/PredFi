import WebSocket, { MessageEvent, CloseEvent, Event, ErrorEvent } from 'ws';

/**
 * A zero-dependency client for the Predict Websocket API.
 * Adapted for Node.js (using 'ws' package).
 */

function neOf<T>(item: T): NonEmptyArray<T> {
    return [item] as NonEmptyArray<T>;
}

function isNonEmpty<T>(items: T[]): items is NonEmptyArray<T> {
    return items.length > 0;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/*
 * Realtime Client
 */

export class RealtimeClient {
    constructor(
        private ws: WebSocket,
        private readonly options: {
            maxConnAttempts: number;
            maxRetryInterval: number;
        },
    ) {
        this.bindAll();
    }

    private topicSubReqIdMap: Map<number, TopicName> = new Map();
    private subscriptions: Map<TopicName, NonEmptyArray<EventCallback>> = new Map();
    private connectionAttempts = 0;
    private requestId = 0;

    private bindAll(): void {
        this.ws.onerror = this.onError.bind(this);
        this.ws.onmessage = this.onMessage.bind(this);
        this.ws.onclose = this.onClose.bind(this);
        this.ws.onopen = this.onOpen.bind(this);
    }

    private async reconnect() {
        const attempt = this.connectionAttempts++;
        if (attempt < this.options.maxConnAttempts) {
            const delay = Math.min(Math.pow(2, attempt) * 1000, this.options.maxRetryInterval);
            await sleep(delay);

            this.ws = new WebSocket(
                this.ws.url,
                this.ws.protocol !== '' ? this.ws.protocol : undefined,
            );
            this.bindAll();
        } else {
            const allHandlers = Array.from(this.subscriptions.values()).flat();
            for (const handler of allHandlers) {
                handler({
                    err: { code: 'ws_disconnected', message: 'Max connection attempts reached' },
                });
            }
        }
    }

    private onOpen = () => {
        console.log("WS Connected");
        this.connectionAttempts = 0;
        for (const topic of this.subscriptions.keys()) {
            this.subUnsub('subscribe', topic);
        }
    };

    private onClose = (event: CloseEvent) => {
        console.log("WS Closed", event.code, event.reason);
        if (!event.wasClean) {
            // @ts-ignore
            return this.reconnect();
        }
    };

    private onMessage = (event: MessageEvent) => {
        const parsed = JSON.parse(event.data as unknown as string) as Response;

        if (parsed.type === 'M') {
            const topic = parsed.topic;
            if (topic === 'heartbeat') {
                this.send({ method: 'heartbeat', data: parsed.data });
            } else {
                const handlers = this.subscriptions.get(parsed.topic);
                for (const handler of handlers || []) {
                    handler({ data: parsed.data });
                }
            }
        } else if (parsed.type === 'R') {
            const requestIdTopic = this.topicSubReqIdMap.get(parsed.requestId);
            if (requestIdTopic) {
                if (parsed.success) {
                    this.topicSubReqIdMap.delete(parsed.requestId);
                } else {
                    const handlers = this.subscriptions.get(requestIdTopic);
                    if (handlers) {
                        for (const handler of handlers) {
                            handler({ err: parsed.error });
                        }
                    }
                    this.subscriptions.delete(requestIdTopic);
                }
                this.topicSubReqIdMap.delete(parsed.requestId);
            } else {
                console.warn(`Unknown response received`, JSON.stringify(parsed, null, 2));
            }
        }
    };

    private onError = (event: ErrorEvent) => {
        const allHandlers = Array.from(this.subscriptions.values()).flat();
        for (const handler of allHandlers) {
            handler({ err: { code: 'ws_error_terminated', message: 'Websocket error' } });
        }
        console.error('RealtimeClientSocketError', event.message);
    };

    private send(data: Requests) {
        if (this.ws.readyState === this.ws.OPEN) {
            if (data.method === 'subscribe') {
                this.topicSubReqIdMap.set(data.requestId, data.params[0]);
            }
            this.ws.send(JSON.stringify(data));
        } else {
            console.warn(`Not connected to WS. Ignoring.`);
        }
    }

    private subUnsub(method: 'subscribe' | 'unsubscribe', topic: string) {
        const data = {
            requestId: this.requestId++,
            method,
            params: neOf(topic),
        };
        this.send(data);
    }

    private getTopicStringFor(topic: Channel): string {
        switch (topic.name) {
            case 'predictOrderbook':
                return ['predictOrderbook', topic.marketId].join('/') as `predictOrderbook${string}`;
            case 'assetPriceUpdate':
                return ['assetPriceUpdate', topic.priceFeedId].join('/') as `assetPriceUpdate${string}`;
            case 'predictWalletEvents':
                return ['predictWalletEvents', topic.jwt].join('/') as `predictWalletEvents${string}`;
        }
    }

    subscribe(topic: Channel, callback: EventCallback): { unsubscribe: () => void } {
        const topicName = this.getTopicStringFor(topic);
        const existing = this.subscriptions.get(topicName);

        if (existing) {
            existing.push(callback);
        } else {
            this.subscriptions.set(topicName, [callback]);
            if (this.ws.readyState === this.ws.OPEN) {
                this.subUnsub('subscribe', topicName);
            }
        }

        return {
            unsubscribe: (): void => {
                const item = this.subscriptions.get(topicName);
                if (!item) {
                    throw new Error('InconsistentState: No subscriptions for this topic');
                }
                const cbRemoved = item.filter((x) => x !== callback);
                if (isNonEmpty(cbRemoved)) {
                    this.subscriptions.set(topicName, cbRemoved);
                } else {
                    this.subscriptions.delete(topicName);
                    this.subUnsub('unsubscribe', topicName);
                }
            },
        };
    }

    close(): void {
        this.ws.close();
    }
}

/* Types (Simplified/Copied) */

export type NonEmptyArray<T> = [T, ...T[]];
export type Pretty<T> = { [K in keyof T]: T[K] } extends infer U ? U : never;
export type AssetPriceUpdate = { price: number; publishTime: number; timestamp: number; };

// Orderbook Types
export type OrderbookItem = [number, number]; // [price, quantity]
export type OrderbookData = {
    marketId: number;
    updateTimestampMs: number;
    asks: OrderbookItem[];
    bids: OrderbookItem[];
};


type BaseEvent = {
    orderId: string;
    timestamp: number;
    details: {
        marketQuestion: string;
        outcome: 'YES' | 'NO';
        quoteType: 'ASK' | 'BID';
        quantity: string;
        price: string;
        strategyType: 'MARKET' | 'LIMIT';
        categorySlug: string;
    };
};

// ... (Other event types can be added if needed, sticking to basics)
export type PredictWalletEvents = BaseEvent & { type: string };

export interface PredictOrderbookChannel { name: 'predictOrderbook'; marketId: number; }
export interface PredictWalletEventsChannel { name: 'predictWalletEvents'; jwt: string; }
export interface AssetPriceUpdateChannel { name: 'assetPriceUpdate'; priceFeedId: number; }

export type Channel = Pretty<PredictOrderbookChannel | PredictWalletEventsChannel | AssetPriceUpdateChannel>;

type WithRequestId<T> = T & { requestId: number };

export type SubscribeRequest = WithRequestId<{ method: 'subscribe'; params: NonEmptyArray<string>; }>;
export type UnsubscribeRequest = WithRequestId<{ method: 'unsubscribe'; params: NonEmptyArray<string>; }>;
export type HeartbeatRequest = { method: 'heartbeat'; data: unknown };
export type Requests = Pretty<HeartbeatRequest | SubscribeRequest | UnsubscribeRequest>;

export type InvalidJson = { code: 'invalid_json'; message?: string };
export type InvalidTopic = { code: 'invalid_topic'; message?: string };
export type InternalServerError = { code: 'internal_server_error'; message?: string };
export type InvalidCredentials = { code: 'invalid_credentials'; message?: string };
export type ResponseError = Pretty<InvalidJson | InvalidTopic | InternalServerError | InvalidCredentials>;

export type RequestResponse<T> = { type: 'R'; requestId: number; } & ({ success: true; data: T } | { success: false; error: ResponseError });
export type MessageResponse<Topic extends string, Data> = { type: 'M'; topic: Topic; data: Data; };
export type MessageResponses =
    | MessageResponse<'heartbeat', unknown>
    | MessageResponse<`predictOrderbook${string}`, OrderbookData>
    | MessageResponse<`predictWalletEvents${string}`, PredictWalletEvents>
    | MessageResponse<`assetPriceUpdate${string}`, AssetPriceUpdate>;

export type Response = Pretty<MessageResponses | RequestResponse<undefined>>;
export type WSError = ResponseError | { code: 'ws_disconnected'; message?: string } | { code: 'ws_error_terminated'; message?: string };
export type TopicName = string;
export type EventCallback = (arg: { err?: null; data: MessageResponses['data'] } | { err: WSError; data?: null }) => void;
