import type { KalshiMarket, NormalizedMarket } from "../types/index.js";
export declare function resetKalshiFetchStats(): void;
export declare function getKalshiFetchStats(): {
    http429: number;
    bytesIn: number;
};
export declare function getKalshiEffectiveRps(): number;
export declare function normalizeKalshi(m: KalshiMarket): NormalizedMarket | null;
export declare function fetchAllKalshiMarkets(): Promise<KalshiMarket[]>;
export declare function fetchKalshiMarketsForEventTickersWithTargets(targetByEvent: Map<string, Set<string>>): Promise<KalshiMarket[]>;
