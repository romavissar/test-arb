import type { MatchedPair, ArbOpportunity, PolymarketMarket, KalshiMarket } from "../types/index.js";
import { config } from "../config.js";
import { appendOpportunity } from "./logging.js";

function hoursUntil(date: Date): number {
  return Math.max(0, (date.getTime() - Date.now()) / (1000 * 60 * 60));
}

function pairPassesQuotePrefilter(pair: MatchedPair): boolean {
  const poly = pair.polymarket;
  const kalshi = pair.kalshi;
  if (poly.volume + kalshi.volume < config.minVolumeUsd) return false;
  const asks = [poly.yesAsk, poly.noAsk, kalshi.yesAsk, kalshi.noAsk];
  for (const a of asks) {
    if (a <= 0 || a >= 1) return false;
  }
  return true;
}

function computeArb(
  pair: MatchedPair,
  polyAsk: number,
  polySide: "YES" | "NO",
  kalshiAsk: number,
  kalshiSide: "YES" | "NO",
): ArbOpportunity | null {
  const combinedCost = polyAsk + kalshiAsk;
  if (combinedCost >= 1.0 || combinedCost <= 0) return null;

  const profitPerContract = 1.0 - combinedCost;
  const profitPct = (profitPerContract / combinedCost) * 100;

  const polyFee = polyAsk * config.polymarketTakerFeeFraction;
  const kalshiFee = kalshiAsk * config.kalshiTakerFeeFraction;
  const estimatedFeesPerContract = polyFee + kalshiFee;
  const netProfitPerContract = profitPerContract - estimatedFeesPerContract;
  const profitPctAfterFees = combinedCost > 0 ? (netProfitPerContract / combinedCost) * 100 : 0;

  const timeToClose = Math.min(
    hoursUntil(pair.polymarket.closeTime),
    hoursUntil(pair.kalshi.closeTime),
  );

  const avgPrice = combinedCost / 2;
  const maxContracts = avgPrice > 0 ? Math.floor(Math.min(pair.kalshi.volume, pair.polymarket.volume) / avgPrice) : 0;
  const estimatedMaxProfit = netProfitPerContract > 0 ? netProfitPerContract * maxContracts : 0;

  return {
    matchScore: pair.matchScore,
    combinedCost,
    profitPerContract,
    profitPct,
    estimatedFeesPerContract,
    profitPctAfterFees,
    maxContracts,
    estimatedMaxProfit,
    timeToClose,
    kalshiSide,
    polymarketSide: polySide,
    kalshiAsk,
    polymarketAsk: polyAsk,
    kalshiMarket: pair.kalshi.raw as KalshiMarket,
    polymarketMarket: pair.polymarket.raw as PolymarketMarket,
    matchedPair: pair,
    detectedAt: new Date(),
  };
}

export function detectArbitrage(pairs: MatchedPair[]): ArbOpportunity[] {
  const opportunities: ArbOpportunity[] = [];

  for (const pair of pairs) {
    if (!pairPassesQuotePrefilter(pair)) continue;

    const poly = pair.polymarket;
    const kalshi = pair.kalshi;

    const arbA = computeArb(pair, poly.noAsk, "NO", kalshi.yesAsk, "YES");
    const arbB = computeArb(pair, poly.yesAsk, "YES", kalshi.noAsk, "NO");

    for (const arb of [arbA, arbB]) {
      if (!arb) continue;
      if (!passesFilters(arb, pair)) continue;
      opportunities.push(arb);

      appendOpportunity({
        event: poly.title,
        polymarketSide: arb.polymarketSide,
        kalshiSide: arb.kalshiSide,
        polymarketAsk: arb.polymarketAsk,
        kalshiAsk: arb.kalshiAsk,
        combinedCost: arb.combinedCost,
        profitPctGross: arb.profitPct,
        profitPctAfterFees: arb.profitPctAfterFees,
        estimatedFeesPerContract: arb.estimatedFeesPerContract,
        matchScore: arb.matchScore,
      });
    }
  }

  opportunities.sort((a, b) => {
    const pa = config.minProfitUsesNet ? a.profitPctAfterFees : a.profitPct;
    const pb = config.minProfitUsesNet ? b.profitPctAfterFees : b.profitPct;
    return pb - pa;
  });
  return opportunities;
}

/** Use for UI / session “best” when MIN_PROFIT_USES_NET toggles gross vs net. */
export function opportunityDisplayProfitPct(o: ArbOpportunity): number {
  return config.minProfitUsesNet ? o.profitPctAfterFees : o.profitPct;
}

function passesFilters(arb: ArbOpportunity, pair: MatchedPair): boolean {
  if (arb.timeToClose < 2) return false;

  const combinedVolume = pair.polymarket.volume + pair.kalshi.volume;
  if (combinedVolume < config.minVolumeUsd) return false;

  const profitForThreshold = config.minProfitUsesNet ? arb.profitPctAfterFees : arb.profitPct;
  if (profitForThreshold < config.minProfitPct) return false;

  if (arb.matchScore < config.matchThreshold) return false;

  if (arb.polymarketAsk <= 0 || arb.polymarketAsk >= 1) return false;
  if (arb.kalshiAsk <= 0 || arb.kalshiAsk >= 1) return false;

  return true;
}
