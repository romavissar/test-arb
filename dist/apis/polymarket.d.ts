import type { PolymarketMarket, NormalizedMarket } from "../types/index.js";
export declare function resetPolymarketFetchStats(): void;
export declare function getPolymarketFetchStats(): {
    http429: number;
    bytesIn: number;
};
export declare function normalizePolymarket(m: PolymarketMarket): NormalizedMarket | null;
export declare function fetchAllPolymarketMarkets(): Promise<PolymarketMarket[]>;
export declare function fetchPolymarketMarketsByConditionIds(conditionIds: string[]): Promise<PolymarketMarket[]>;
