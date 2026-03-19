import { config } from "./config.js";
import {
  fetchAllPolymarketMarkets,
  fetchPolymarketMarketsByConditionIds,
  normalizePolymarket,
  resetPolymarketFetchStats,
  getPolymarketFetchStats,
} from "./apis/polymarket.js";
import {
  fetchAllKalshiMarkets,
  fetchKalshiMarketsForEventTickersWithTargets,
  normalizeKalshi,
  resetKalshiFetchStats,
  getKalshiFetchStats,
  getKalshiEffectiveRps,
} from "./apis/kalshi.js";
import { generateDemoKalshiMarkets } from "./apis/kalshiDemo.js";
import { matchMarkets, getMatchCacheSize, syncMatchedPairs, getMatchedPairs } from "./core/matcher.js";
import { detectArbitrage, opportunityDisplayProfitPct } from "./core/arbitrage.js";
import { render, type RenderState } from "./display/renderer.js";
import { startWebServer, pushState } from "./web/server.js";
import { appendError, appendMetricLine } from "./core/logging.js";
import { RollingCycleLatency } from "./core/metrics.js";
import type { NormalizedMarket, ArbOpportunity, SessionStats, MatchedPair, PolymarketMarket, KalshiMarket } from "./types/index.js";

// ─── Session state ───

const stats: SessionStats = {
  totalCycles: 0,
  totalOpportunities: 0,
  bestOpportunity: null,
  startedAt: new Date(),
};

const rollingLatency = new RollingCycleLatency(config.metricsRollingCycles);

let lastPolyFetch = Date.now();
let lastKalshiFetch = Date.now();
let running = true;
let matchedPairs: MatchedPair[] = [];

// ─── Graceful shutdown ───

function printSummary(): void {
  console.log("\n\n--- Session Summary ---");
  console.log(`  Total cycles:        ${stats.totalCycles}`);
  console.log(`  Total opportunities: ${stats.totalOpportunities}`);
  if (stats.bestOpportunity) {
    const p = opportunityDisplayProfitPct(stats.bestOpportunity);
    console.log(
      `  Best opportunity:    +${p.toFixed(1)}% on "${stats.bestOpportunity.matchedPair.polymarket.title}"`,
    );
  }
  const duration = (Date.now() - stats.startedAt.getTime()) / 1000;
  console.log(`  Session duration:    ${Math.floor(duration / 60)}m ${Math.floor(duration % 60)}s`);
  console.log("--- End ---\n");
}

process.on("SIGINT", () => {
  running = false;
  printSummary();
  process.exit(0);
});

process.on("SIGTERM", () => {
  running = false;
  printSummary();
  process.exit(0);
});

// ─── Main poll loop ───

async function pollCycle(): Promise<void> {
  const cycleStart = Date.now();
  stats.totalCycles++;

  const doDiscovery = matchedPairs.length === 0 || stats.totalCycles % config.discoveryIntervalCycles === 0;

  let polyFetchMs = 0;
  let kalshiFetchMs = 0;
  let normalizeMs = 0;
  let matchMs = 0;
  let arbMs = 0;
  let renderMs = 0;

  // Render scanning state
  const renderState: RenderState = {
    opportunities: [],
    matchedPairs: getMatchCacheSize(),
    polymarketCount: 0,
    kalshiCount: 0,
    scanProgress: 0.1,
    scanPhase: "Fetching markets...",
    polyStaleSeconds: (Date.now() - lastPolyFetch) / 1000,
    kalshiStaleSeconds: (Date.now() - lastKalshiFetch) / 1000,
    stats,
  };

  let polyRaw: Awaited<ReturnType<typeof fetchAllPolymarketMarkets>> = [];
  let kalshiRaw: Awaited<ReturnType<typeof fetchAllKalshiMarkets>> = [];

  try {
    resetPolymarketFetchStats();
    resetKalshiFetchStats();

    renderState.scanPhase = "Fetching markets...";
    renderState.scanProgress = 0.2;
    render(renderState);

    const polyPromise = doDiscovery
      ? (async () => {
          const t = Date.now();
          const r = await fetchAllPolymarketMarkets().catch((err) => {
            appendError(`Polymarket fetch failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
          });
          polyFetchMs = Date.now() - t;
          return r;
        })()
      : (async () => {
          const t = Date.now();
          const conditionIds = Array.from(
            new Set(matchedPairs.map((p) => (p.polymarket.raw as PolymarketMarket).condition_id)),
          );
          const r = await fetchPolymarketMarketsByConditionIds(conditionIds).catch((err) => {
            appendError(`Polymarket refresh fetch failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
          });
          polyFetchMs = Date.now() - t;
          return r;
        })();

    const kalshiPromise = doDiscovery
      ? (config.demoMode
          ? (async () => {
              const t = Date.now();
              const r = generateDemoKalshiMarkets();
              kalshiFetchMs = Date.now() - t;
              return r;
            })()
          : (async () => {
              const t = Date.now();
              const r = await fetchAllKalshiMarkets().catch((err) => {
                appendError(`Kalshi fetch failed: ${err instanceof Error ? err.message : String(err)}`);
                return [];
              });
              kalshiFetchMs = Date.now() - t;
              return r;
            })())
      : (async () => {
          const t = Date.now();
          if (config.demoMode) {
            const r = generateDemoKalshiMarkets();
            kalshiFetchMs = Date.now() - t;
            return r;
          }
          const targetByEvent = new Map<string, Set<string>>();
          for (const p of matchedPairs) {
            const k = p.kalshi.raw as KalshiMarket;
            const ev = k.event_ticker;
            const tick = k.ticker;
            if (!ev || !tick) continue;
            let set = targetByEvent.get(ev);
            if (!set) {
              set = new Set<string>();
              targetByEvent.set(ev, set);
            }
            set.add(tick);
          }
          const r = await fetchKalshiMarketsForEventTickersWithTargets(targetByEvent).catch((err) => {
            appendError(`Kalshi refresh fetch failed: ${err instanceof Error ? err.message : String(err)}`);
            return [];
          });
          kalshiFetchMs = Date.now() - t;
          return r;
        })();

    const [polyResult, kalshiResult] = await Promise.all([polyPromise, kalshiPromise]);

    polyRaw = polyResult;
    kalshiRaw = kalshiResult;

    if (polyRaw.length > 0) lastPolyFetch = Date.now();
    if (kalshiRaw.length > 0 || config.demoMode) lastKalshiFetch = Date.now();
  } catch (err) {
    appendError(`Fetch cycle error: ${err instanceof Error ? err.message : String(err)}`);
  }

  const polyStats = getPolymarketFetchStats();
  const kalshiStats = getKalshiFetchStats();

  renderState.scanPhase = "Normalizing...";
  renderState.scanProgress = 0.4;
  render(renderState);

  const tNorm = Date.now();
  const polyMarkets: NormalizedMarket[] = polyRaw
    .map(normalizePolymarket)
    .filter((m): m is NormalizedMarket => m !== null);

  const kalshiMarkets: NormalizedMarket[] = kalshiRaw
    .map(normalizeKalshi)
    .filter((m): m is NormalizedMarket => m !== null);
  normalizeMs = Date.now() - tNorm;

  renderState.polymarketCount = polyMarkets.length;
  renderState.kalshiCount = kalshiMarkets.length;

  const tMatch = Date.now();
  if (doDiscovery) {
    renderState.scanPhase = "Matching markets...";
    renderState.scanProgress = 0.6;
    render(renderState);

    matchedPairs = matchMarkets(polyMarkets, kalshiMarkets);
  } else {
    renderState.scanPhase = "Syncing matched pairs...";
    renderState.scanProgress = 0.6;
    render(renderState);

    matchedPairs = syncMatchedPairs(polyMarkets, kalshiMarkets);
    if (matchedPairs.length === 0) matchedPairs = getMatchedPairs();
  }
  matchMs = Date.now() - tMatch;

  renderState.matchedPairs = matchedPairs.length;

  renderState.scanPhase = "Detecting arbitrage...";
  renderState.scanProgress = 0.8;
  render(renderState);

  const polyStale = (Date.now() - lastPolyFetch) / 1000 > 10;
  const kalshiStale = (Date.now() - lastKalshiFetch) / 1000 > 10;

  const tArb = Date.now();
  let opportunities: ArbOpportunity[] = [];
  if (!polyStale && !kalshiStale) {
    opportunities = detectArbitrage(matchedPairs);
  }
  arbMs = Date.now() - tArb;

  stats.totalOpportunities += opportunities.filter(
    (o) => opportunityDisplayProfitPct(o) >= config.minProfitPct,
  ).length;
  for (const opp of opportunities) {
    if (
      !stats.bestOpportunity ||
      opportunityDisplayProfitPct(opp) > opportunityDisplayProfitPct(stats.bestOpportunity)
    ) {
      stats.bestOpportunity = opp;
    }
  }

  const cycleMs = Date.now() - cycleStart;
  renderState.opportunities = opportunities;
  renderState.scanPhase = `Scan complete (${cycleMs}ms)`;
  renderState.scanProgress = 1.0;
  renderState.polyStaleSeconds = (Date.now() - lastPolyFetch) / 1000;
  renderState.kalshiStaleSeconds = (Date.now() - lastKalshiFetch) / 1000;

  const tRender = Date.now();
  render(renderState);
  renderMs = Date.now() - tRender;

  rollingLatency.push(cycleMs);
  const roll = rollingLatency.summary();

  appendMetricLine({
    type: "cycle",
    cycle: stats.totalCycles,
    discovery: doDiscovery,
    poly_fetch_ms: polyFetchMs,
    kalshi_fetch_ms: kalshiFetchMs,
    normalize_ms: normalizeMs,
    match_ms: matchMs,
    arb_ms: arbMs,
    render_ms: renderMs,
    poly_http_429: polyStats.http429,
    kalshi_http_429: kalshiStats.http429,
    poly_bytes_in: polyStats.bytesIn,
    kalshi_bytes_in: kalshiStats.bytesIn,
    cycle_total_ms: cycleMs,
    kalshi_bucket_rps: config.demoMode ? null : getKalshiEffectiveRps(),
    rolling_n: roll.n,
    rolling_p50_ms: roll.p50_ms,
    rolling_p95_ms: roll.p95_ms,
  });

  pushState({
    opportunities,
    matchedPairs: renderState.matchedPairs,
    polymarketCount: renderState.polymarketCount,
    kalshiCount: renderState.kalshiCount,
    scanPhase: renderState.scanPhase,
    scanProgress: renderState.scanProgress,
    polyStaleSeconds: renderState.polyStaleSeconds,
    kalshiStaleSeconds: renderState.kalshiStaleSeconds,
    stats,
    demoMode: config.demoMode,
  });
}

// ─── Entry point ───

async function main(): Promise<void> {
  console.log("Starting Polymarket ↔ Kalshi Arbitrage Screener...\n");

  if (config.demoMode) {
    console.log("🧪 DEMO MODE — using simulated Kalshi data.\n");
  } else if (!config.kalshiApiKey) {
    console.log("ℹ No KALSHI_API_KEY — using public Kalshi read API (api.elections.kalshi.com).\n");
  }

  console.log(`Metrics: append-only metrics.log (rolling p50/p95 over last ${config.metricsRollingCycles} cycles)\n`);

  startWebServer();

  await pollCycle();

  while (running) {
    await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    if (!running) break;
    await pollCycle();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
