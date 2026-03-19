import { config } from "../config.js";
import { TokenBucket } from "../core/rateLimit.js";
import { createChecksum, createStructureChecksum } from "../core/checksums.js";
import { appendError } from "../core/logging.js";
// Use Gamma API — supports active/closed filters, unlike CLOB which paginates from oldest
const BASE_URL = "https://gamma-api.polymarket.com";
const bucket = new TokenBucket(config.polymarketBucketMax, config.polymarketBucketRefillRps);
let polyHttp429 = 0;
let polyBytesIn = 0;
export function resetPolymarketFetchStats() {
    polyHttp429 = 0;
    polyBytesIn = 0;
}
export function getPolymarketFetchStats() {
    return { http429: polyHttp429, bytesIn: polyBytesIn };
}
function recordPolyBody(body) {
    try {
        polyBytesIn += JSON.stringify(body).length;
    }
    catch {
        // ignore
    }
}
function parseGammaMarket(raw) {
    let outcomes;
    let prices;
    try {
        outcomes = JSON.parse(raw.outcomes ?? "[]");
        prices = JSON.parse(raw.outcomePrices ?? "[]");
    }
    catch {
        return null;
    }
    if (outcomes.length !== 2 || prices.length !== 2)
        return null;
    const tokens = outcomes.map((outcome, i) => ({
        token_id: `${raw.conditionId}_${i}`,
        outcome,
        price: parseFloat(prices[i]) || 0,
    }));
    return {
        condition_id: raw.conditionId,
        question: raw.question ?? "",
        tokens,
        volume: raw.volumeNum ?? (parseFloat(raw.volume ?? "0") || 0),
        end_date_iso: raw.endDate ?? "",
        active: raw.active ?? false,
        closed: raw.closed ?? false,
    };
}
export function normalizePolymarket(m) {
    // Accept "Yes"/"No" outcomes or treat first token as Yes, second as No
    const yesToken = m.tokens.find((t) => t.outcome === "Yes") ?? m.tokens[0];
    const noToken = m.tokens.find((t) => t.outcome === "No") ?? m.tokens[1];
    if (!yesToken || !noToken)
        return null;
    if (yesToken === noToken)
        return null;
    const closeTime = new Date(m.end_date_iso);
    const closeMs = closeTime.getTime();
    return {
        id: `poly_${m.condition_id}`,
        source: "polymarket",
        title: m.question,
        normalizedTitle: "",
        tokens: new Set(),
        yesAsk: yesToken.price,
        noAsk: noToken.price,
        volume: m.volume,
        closeTime,
        checksum: createChecksum(yesToken.price, noToken.price, m.volume),
        structureChecksum: createStructureChecksum(m.question, Number.isNaN(closeMs) ? 0 : closeMs),
        raw: m,
    };
}
export async function fetchAllPolymarketMarkets() {
    const markets = [];
    let offset = 0;
    const pageSize = config.polymarketPageSize;
    for (let page = 0; page < config.polymarketDiscoveryMaxPages; page++) {
        await bucket.acquire();
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs + 5000);
        try {
            const url = new URL(`${BASE_URL}/markets`);
            url.searchParams.set("limit", String(pageSize));
            url.searchParams.set("offset", String(offset));
            url.searchParams.set("active", "true");
            url.searchParams.set("closed", "false");
            const res = await fetch(url.toString(), {
                signal: controller.signal,
                headers: { "Accept": "application/json" },
            });
            if (res.status === 429) {
                clearTimeout(timeout);
                polyHttp429++;
                const retryAfter = parseInt(res.headers.get("retry-after") ?? "2", 10);
                await new Promise((r) => setTimeout(r, retryAfter * 1000));
                continue;
            }
            if (!res.ok) {
                throw new Error(`Polymarket HTTP ${res.status}: ${res.statusText}`);
            }
            const data = (await res.json());
            recordPolyBody(data);
            if (!Array.isArray(data) || data.length === 0)
                break;
            for (const raw of data) {
                const parsed = parseGammaMarket(raw);
                if (parsed && parsed.active && !parsed.closed) {
                    markets.push(parsed);
                }
            }
            offset += data.length;
            if (data.length < pageSize)
                break; // last page
        }
        catch (err) {
            if (err instanceof DOMException && err.name === "AbortError") {
                appendError("Polymarket fetch timeout");
            }
            else {
                appendError(`Polymarket fetch error: ${err instanceof Error ? err.message : String(err)}`);
            }
            break;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    return markets;
}
function chunk(arr, size) {
    const out = [];
    for (let i = 0; i < arr.length; i += size)
        out.push(arr.slice(i, i + size));
    return out;
}
// Refresh mode: fetch only the markets for known matched condition IDs.
export async function fetchPolymarketMarketsByConditionIds(conditionIds) {
    if (conditionIds.length === 0)
        return [];
    const pageSize = config.polymarketPageSize;
    const batchSize = config.polymarketConditionIdsBatchSize;
    const allMarkets = [];
    for (const batch of chunk(conditionIds, batchSize)) {
        let attempt = 0;
        while (attempt < 2) {
            attempt++;
            await bucket.acquire();
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), config.requestTimeoutMs + 5000);
            try {
                const url = new URL(`${BASE_URL}/markets`);
                url.searchParams.set("limit", String(pageSize));
                url.searchParams.set("active", "true");
                url.searchParams.set("closed", "false");
                // Gamma accepts condition_ids as an array query param.
                // We append multiple times to form a list.
                for (const id of batch)
                    url.searchParams.append("condition_ids", id);
                const res = await fetch(url.toString(), {
                    signal: controller.signal,
                    headers: { "Accept": "application/json" },
                });
                if (res.status === 429) {
                    polyHttp429++;
                    const retryAfter = parseInt(res.headers.get("retry-after") ?? "2", 10);
                    await new Promise((r) => setTimeout(r, retryAfter * 1000));
                    continue;
                }
                if (!res.ok) {
                    throw new Error(`Polymarket condition_ids HTTP ${res.status}: ${res.statusText}`);
                }
                const data = (await res.json());
                recordPolyBody(data);
                if (!Array.isArray(data))
                    break;
                for (const raw of data) {
                    const parsed = parseGammaMarket(raw);
                    if (parsed && parsed.active && !parsed.closed)
                        allMarkets.push(parsed);
                }
                break; // success
            }
            catch (err) {
                if (err instanceof DOMException && err.name === "AbortError") {
                    appendError("Polymarket refresh fetch timeout");
                }
                else {
                    appendError(`Polymarket refresh fetch error: ${err instanceof Error ? err.message : String(err)}`);
                }
                break;
            }
            finally {
                clearTimeout(timeout);
            }
        }
    }
    return allMarkets;
}
//# sourceMappingURL=polymarket.js.map