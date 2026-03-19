// ─── Polymarket Types ───

export interface PolymarketToken {
  token_id: string;
  outcome: string;
  price: number;
}

export interface PolymarketMarket {
  condition_id: string;
  question: string;
  tokens: PolymarketToken[];
  volume: number;
  end_date_iso: string;
  active: boolean;
  closed: boolean;
}

export interface PolymarketResponse {
  data: PolymarketMarket[];
  next_cursor: string;
}

// ─── Kalshi Types ───

export interface KalshiMarket {
  ticker: string;
  title: string;
  yes_ask: number;
  no_ask: number;
  volume: number;
  close_time: string;
  status: string;
  event_ticker: string;
}

export interface KalshiResponse {
  markets: KalshiMarket[];
  cursor: string;
}

// ─── Normalized Market ───

export interface NormalizedMarket {
  id: string;
  source: "polymarket" | "kalshi";
  title: string;
  normalizedTitle: string;
  tokens: Set<string>;
  yesAsk: number;
  noAsk: number;
  volume: number;
  closeTime: Date;
  /** Price/volume fingerprint for quote updates. */
  checksum: string;
  /** Title + close time — rematch when structure changes, not on every quote tick. */
  structureChecksum: string;
  raw: PolymarketMarket | KalshiMarket;
}

// ─── Matching Types ───

export interface MatchedPair {
  id: string;
  polymarket: NormalizedMarket;
  kalshi: NormalizedMarket;
  matchScore: number;
  matchedAt: Date;
}

// ─── Arbitrage Types ───

export interface ArbOpportunity {
  matchScore: number;
  combinedCost: number;
  profitPerContract: number;
  /** Gross edge % (before estimated platform fees). */
  profitPct: number;
  /** Estimated combined taker fees per $1 nominal (both legs), as a decimal fraction of notional. */
  estimatedFeesPerContract: number;
  /** Profit % after subtracting `estimatedFeesPerContract` from gross edge. */
  profitPctAfterFees: number;
  maxContracts: number;
  estimatedMaxProfit: number;
  timeToClose: number;
  kalshiSide: "YES" | "NO";
  polymarketSide: "YES" | "NO";
  kalshiAsk: number;
  polymarketAsk: number;
  kalshiMarket: KalshiMarket;
  polymarketMarket: PolymarketMarket;
  matchedPair: MatchedPair;
  detectedAt: Date;
}

// ─── Session Stats ───

export interface SessionStats {
  totalCycles: number;
  totalOpportunities: number;
  bestOpportunity: ArbOpportunity | null;
  startedAt: Date;
}

// ─── Config ───

export interface Config {
  kalshiApiKey: string;
  demoMode: boolean;
  pollIntervalMs: number;
  // How often to re-run full discovery (matching across the entire fetched universe).
  // Refresh cycles only update quotes for already-matched pairs.
  discoveryIntervalCycles: number;
  minProfitPct: number;
  minVolumeUsd: number;
  matchThreshold: number;
  maxCloseDateDeltaDays: number;
  /** Minimum shared normalized tokens for candidate pairs (default 2). */
  minSharedTokens: number;
  /** If true, drop pairs where explicit years in titles disagree (cheap prune). */
  matcherYearGate: boolean;
  polymarketPageSize: number;
  polymarketBucketMax: number;
  polymarketBucketRefillRps: number;
  // Max number of /markets pages to fetch during initial discovery.
  polymarketDiscoveryMaxPages: number;
  // Chunk size for Gamma condition_ids filtering during refresh.
  polymarketConditionIdsBatchSize: number;
  kalshiPageSize: number;
  /** Adaptive rate: min / max effective RPS for Kalshi HTTP. */
  kalshiRateMinRps: number;
  kalshiRateMaxRps: number;
  kalshiAdaptiveSuccessBeforeBump: number;
  kalshiAdaptiveBumpRps: number;
  kalshiAdaptiveDecayOn429: number;
  requestTimeoutMs: number;
  // Kalshi discovery caps
  kalshiEventsDiscoveryMaxPages: number;
  kalshiMaxEventsDiscovery: number;
  kalshiMarketsMaxPagesPerEventDiscovery: number;
  // Kalshi refresh caps (when fetching markets for a small set of already-matched events)
  kalshiMarketsMaxPagesPerEventRefresh: number;
  /** Estimated taker fee as fraction per leg (e.g. 0.005 = 0.5%). */
  polymarketTakerFeeFraction: number;
  kalshiTakerFeeFraction: number;
  /** If true, MIN_PROFIT_PCT applies to profitPctAfterFees instead of gross profitPct. */
  minProfitUsesNet: boolean;
  /** Rolling window size for p50/p95 cycle latency in metrics.log summaries. */
  metricsRollingCycles: number;
}
