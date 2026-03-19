import { config } from "../config.js";
import { TokenBucket, AdaptiveRateLimiter } from "../core/rateLimit.js";
import { createChecksum, createStructureChecksum } from "../core/checksums.js";
import { appendError } from "../core/logging.js";
// Public API — no auth needed for GET requests
const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const kalshiBucket = new TokenBucket(Math.max(1, Math.ceil(config.kalshiRateMaxRps)), config.kalshiRateMinRps);
const kalshiAdaptive = new AdaptiveRateLimiter(kalshiBucket, config.kalshiRateMinRps, config.kalshiRateMaxRps, config.kalshiAdaptiveSuccessBeforeBump, config.kalshiAdaptiveBumpRps, config.kalshiAdaptiveDecayOn429);
const HEADERS = { "Accept": "application/json" };
let kalshiHttp429 = 0;
let kalshiBytesIn = 0;
/** Increments each discovery run to rotate through lower-priority events. */
let discoveryRotationIndex = 0;
export function resetKalshiFetchStats() {
    kalshiHttp429 = 0;
    kalshiBytesIn = 0;
}
export function getKalshiFetchStats() {
    return { http429: kalshiHttp429, bytesIn: kalshiBytesIn };
}
export function getKalshiEffectiveRps() {
    return kalshiAdaptive.effectiveRps;
}
function parsePrice(dollars, cents) {
    if (dollars && dollars !== "0.0000") {
        const parsed = parseFloat(dollars);
        if (!isNaN(parsed))
            return parsed;
    }
    if (cents && cents > 0)
        return cents / 100;
    return 0;
}
function buildTitle(market, event) {
    const sub = market.yes_sub_title || market.subtitle || "";
    if (sub && event) {
        return `${event.title} - ${sub}`;
    }
    return market.title || event?.title || "";
}
export function normalizeKalshi(m) {
    if (m.yes_ask <= 0 || m.no_ask <= 0)
        return null;
    const closeTime = new Date(m.close_time);
    const closeMs = closeTime.getTime();
    const title = m.title;
    return {
        id: `kalshi_${m.ticker}`,
        source: "kalshi",
        title,
        normalizedTitle: "",
        tokens: new Set(),
        yesAsk: m.yes_ask,
        noAsk: m.no_ask,
        volume: m.volume,
        closeTime,
        checksum: createChecksum(m.yes_ask, m.no_ask, m.volume),
        structureChecksum: createStructureChecksum(title, Number.isNaN(closeMs) ? 0 : closeMs),
        raw: m,
    };
}
async function kalshiFetchJson(url, signal, maxAttempts = 5) {
    for (let i = 0; i < maxAttempts; i++) {
        await kalshiAdaptive.acquire();
        const res = await fetch(url, { signal, headers: HEADERS });
        if (res.status === 429) {
            kalshiHttp429++;
            kalshiAdaptive.record429();
            const backoff = Math.min(2000 * Math.pow(2, i), 30000);
            appendError(`Kalshi 429 — backing off ${backoff}ms`);
            await new Promise((r) => setTimeout(r, backoff));
            continue;
        }
        if (res.status >= 500 && i < maxAttempts - 1) {
            await new Promise((r) => setTimeout(r, 1000));
            continue;
        }
        if (!res.ok) {
            throw new Error(`Kalshi HTTP ${res.status}`);
        }
        const body = (await res.json());
        try {
            kalshiBytesIn += JSON.stringify(body).length;
        }
        catch {
            // ignore
        }
        kalshiAdaptive.recordSuccess();
        return body;
    }
    throw new Error("Kalshi: max retries exceeded");
}
function isSportsEventCategory(category) {
    const c = category?.toLowerCase() ?? "";
    return c.includes("sport") || c === "sports";
}
const PRIORITY_KEYWORDS = [
    "politic", "election", "fed", "fomc", "rate", "cpi", "inflation", "gdp", "recession",
    "crypto", "bitcoin", "btc", "ethereum", "eth", "macro", "president", "senate", "house",
    "trump", "biden", "ukraine", "china", "tariff", "nato",
];
const PRIORITY_CATEGORIES = new Set(["politics", "elections", "economics", "financials", "crypto", "world", "science and technology"].map((s) => s.toLowerCase()));
function eventPriorityScore(e) {
    const hay = `${e.category} ${e.title} ${e.sub_title}`.toLowerCase();
    let score = 0;
    if (PRIORITY_CATEGORIES.has(e.category?.toLowerCase() ?? ""))
        score += 6;
    for (const kw of PRIORITY_KEYWORDS) {
        if (hay.includes(kw))
            score += 2;
    }
    return score;
}
function selectDiscoveryEvents(events) {
    const nonSports = events.filter((e) => !isSportsEventCategory(e.category));
    const scored = nonSports.map((e) => ({ e, s: eventPriorityScore(e) }));
    scored.sort((a, b) => b.s - a.s || a.e.event_ticker.localeCompare(b.e.event_ticker));
    const cap = config.kalshiMaxEventsDiscovery;
    if (scored.length <= cap) {
        return scored.map((x) => x.e);
    }
    const high = scored.filter((x) => x.s > 0).map((x) => x.e);
    if (high.length >= cap) {
        return high.slice(0, cap);
    }
    const low = scored.filter((x) => x.s === 0).map((x) => x.e);
    const need = cap - high.length;
    const start = low.length > 0 ? discoveryRotationIndex % low.length : 0;
    const tail = [];
    for (let i = 0; i < need && low.length > 0; i++) {
        tail.push(low[(start + i) % low.length]);
    }
    return [...high, ...tail];
}
async function fetchAllEvents() {
    const events = [];
    let cursor = "";
    const MAX_PAGES = config.kalshiEventsDiscoveryMaxPages;
    const seenPages = new Set();
    for (let page = 0; page < MAX_PAGES; page++) {
        const pageKey = cursor || "__first__";
        const dedupKey = `events:${pageKey}`;
        if (seenPages.has(dedupKey))
            break;
        seenPages.add(dedupKey);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs + 3000);
        try {
            const url = new URL(`${BASE_URL}/events`);
            url.searchParams.set("limit", String(config.kalshiPageSize));
            if (cursor)
                url.searchParams.set("cursor", cursor);
            const body = await kalshiFetchJson(url.toString(), controller.signal);
            const data = body.events ?? [];
            events.push(...data);
            cursor = body.cursor ?? "";
            if (!cursor || data.length === 0)
                break;
        }
        catch (err) {
            appendError(`Kalshi events error: ${err instanceof Error ? err.message : String(err)}`);
            break;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    return events;
}
async function fetchMarketsForEvent(eventTicker) {
    const markets = [];
    let cursor = "";
    const seenPages = new Set();
    for (let page = 0; page < config.kalshiMarketsMaxPagesPerEventDiscovery; page++) {
        const pageKey = `${eventTicker}|${cursor || "__start__"}`;
        if (seenPages.has(pageKey))
            break;
        seenPages.add(pageKey);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs + 3000);
        try {
            const url = new URL(`${BASE_URL}/markets`);
            url.searchParams.set("limit", String(config.kalshiPageSize));
            url.searchParams.set("event_ticker", eventTicker);
            if (cursor)
                url.searchParams.set("cursor", cursor);
            const body = await kalshiFetchJson(url.toString(), controller.signal);
            const data = body.markets ?? [];
            markets.push(...data);
            cursor = body.cursor ?? "";
            if (!cursor || data.length === 0)
                break;
        }
        catch (err) {
            appendError(`Kalshi market fetch error (${eventTicker}): ${err instanceof Error ? err.message : String(err)}`);
            break;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    return markets;
}
export async function fetchAllKalshiMarkets() {
    discoveryRotationIndex++;
    const events = await fetchAllEvents();
    const relevantEvents = selectDiscoveryEvents(events);
    const allMarkets = [];
    for (const event of relevantEvents) {
        const markets = await fetchMarketsForEvent(event.event_ticker);
        for (const raw of markets) {
            if (raw.status !== "active")
                continue;
            const yesAsk = parsePrice(raw.yes_ask_dollars, raw.yes_ask);
            const noAsk = parsePrice(raw.no_ask_dollars, raw.no_ask);
            allMarkets.push({
                ticker: raw.ticker,
                title: buildTitle(raw, event),
                yes_ask: yesAsk,
                no_ask: noAsk,
                volume: raw.volume ?? 0,
                close_time: raw.close_time ?? "",
                status: raw.status,
                event_ticker: raw.event_ticker ?? "",
            });
        }
    }
    return allMarkets;
}
async function fetchMarketsForEventTargets(eventTicker, targetTickers) {
    const markets = [];
    let cursor = "";
    const seenPages = new Set();
    if (targetTickers.size === 0)
        return markets;
    for (let page = 0; page < config.kalshiMarketsMaxPagesPerEventRefresh; page++) {
        if (targetTickers.size === 0)
            break;
        const pageKey = `${eventTicker}|${cursor || "__start__"}`;
        if (seenPages.has(pageKey))
            break;
        seenPages.add(pageKey);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs + 3000);
        try {
            const url = new URL(`${BASE_URL}/markets`);
            url.searchParams.set("limit", String(config.kalshiPageSize));
            url.searchParams.set("event_ticker", eventTicker);
            if (cursor)
                url.searchParams.set("cursor", cursor);
            const body = await kalshiFetchJson(url.toString(), controller.signal);
            const data = body.markets ?? [];
            for (const raw of data) {
                if (raw.status !== "active")
                    continue;
                if (!targetTickers.has(raw.ticker))
                    continue;
                markets.push(raw);
                targetTickers.delete(raw.ticker);
            }
            cursor = body.cursor ?? "";
            if (!cursor || data.length === 0)
                break;
        }
        catch (err) {
            appendError(`Kalshi refresh market fetch error (${eventTicker}): ${err instanceof Error ? err.message : String(err)}`);
            break;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    return markets;
}
export async function fetchKalshiMarketsForEventTickersWithTargets(targetByEvent) {
    const out = [];
    for (const [eventTicker, tickers] of targetByEvent.entries()) {
        const remaining = new Set(tickers);
        const rawMarkets = await fetchMarketsForEventTargets(eventTicker, remaining);
        for (const raw of rawMarkets) {
            const yesAsk = parsePrice(raw.yes_ask_dollars, raw.yes_ask);
            const noAsk = parsePrice(raw.no_ask_dollars, raw.no_ask);
            out.push({
                ticker: raw.ticker,
                title: raw.title,
                yes_ask: yesAsk,
                no_ask: noAsk,
                volume: raw.volume ?? 0,
                close_time: raw.close_time ?? "",
                status: raw.status,
                event_ticker: raw.event_ticker ?? eventTicker,
            });
        }
    }
    return out;
}
//# sourceMappingURL=kalshi.js.map