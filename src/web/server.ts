import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { ArbOpportunity, SessionStats } from "../types/index.js";
import { opportunityDisplayProfitPct } from "../core/arbitrage.js";
import { config } from "../config.js";

const PORT = parseInt(process.env.WEB_PORT ?? "3847", 10);

// ─── Shared state pushed from main loop ───

export interface WebState {
  opportunities: ArbOpportunity[];
  matchedPairs: number;
  polymarketCount: number;
  kalshiCount: number;
  scanPhase: string;
  scanProgress: number;
  polyStaleSeconds: number;
  kalshiStaleSeconds: number;
  stats: SessionStats;
  demoMode: boolean;
}

let currentState: WebState = {
  opportunities: [],
  matchedPairs: 0,
  polymarketCount: 0,
  kalshiCount: 0,
  scanPhase: "Starting...",
  scanProgress: 0,
  polyStaleSeconds: 0,
  kalshiStaleSeconds: 0,
  stats: { totalCycles: 0, totalOpportunities: 0, bestOpportunity: null, startedAt: new Date() },
  demoMode: false,
};

const sseClients = new Set<ServerResponse>();

export function pushState(state: WebState): void {
  currentState = state;
  const json = JSON.stringify(serializeState(state));
  for (const res of sseClients) {
    try {
      res.write(`data: ${json}\n\n`);
    } catch {
      sseClients.delete(res);
    }
  }
}

function serializeState(s: WebState): Record<string, unknown> {
  return {
    opportunities: s.opportunities.map((o) => ({
      event: o.matchedPair.polymarket.title,
      polymarketSide: o.polymarketSide,
      kalshiSide: o.kalshiSide,
      polymarketAsk: o.polymarketAsk,
      kalshiAsk: o.kalshiAsk,
      combinedCost: o.combinedCost,
      profitPerContract: o.profitPerContract,
      profitPctGross: o.profitPct,
      profitPctAfterFees: o.profitPctAfterFees,
      profitPctDisplay: opportunityDisplayProfitPct(o),
      profitPerContractDisplay: config.minProfitUsesNet
        ? o.profitPerContract - o.estimatedFeesPerContract
        : o.profitPerContract,
      estimatedFeesPerContract: o.estimatedFeesPerContract,
      matchScore: o.matchScore,
      timeToClose: o.timeToClose,
      maxContracts: o.maxContracts,
      estimatedMaxProfit: o.estimatedMaxProfit,
      detectedAt: o.detectedAt,
    })),
    matchedPairs: s.matchedPairs,
    polymarketCount: s.polymarketCount,
    kalshiCount: s.kalshiCount,
    scanPhase: s.scanPhase,
    scanProgress: s.scanProgress,
    polyStaleSeconds: s.polyStaleSeconds,
    kalshiStaleSeconds: s.kalshiStaleSeconds,
    totalCycles: s.stats.totalCycles,
    totalOpportunities: s.stats.totalOpportunities,
    bestProfitPct: s.stats.bestOpportunity ? opportunityDisplayProfitPct(s.stats.bestOpportunity) : null,
    minProfitUsesNet: config.minProfitUsesNet,
    bestEvent: s.stats.bestOpportunity?.matchedPair.polymarket.title ?? null,
    startedAt: s.stats.startedAt,
    demoMode: s.demoMode,
  };
}

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  if (req.url === "/api/state") {
    res.writeHead(200, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(serializeState(currentState)));
    return;
  }

  if (req.url === "/api/events") {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });
    res.write(`data: ${JSON.stringify(serializeState(currentState))}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
    return;
  }

  // Serve the HTML UI
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML_PAGE);
}

export function startWebServer(): void {
  const server = createServer(handleRequest);
  server.listen(PORT, () => {
    console.log(`Web UI: http://localhost:${PORT}\n`);
  });
}

// ─── Inline HTML ───

const HTML_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Arb Screener</title>
<style>
  :root {
    --bg: #0a0e17;
    --surface: #111827;
    --border: #1e293b;
    --text: #e2e8f0;
    --text-dim: #64748b;
    --green: #22c55e;
    --green-bright: #4ade80;
    --yellow: #eab308;
    --red: #ef4444;
    --cyan: #06b6d4;
    --purple: #a78bfa;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
  }
  .header {
    background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 100%);
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 12px;
  }
  .header h1 {
    font-size: 16px;
    font-weight: 700;
    color: var(--cyan);
    letter-spacing: 0.5px;
  }
  .header-stats {
    display: flex;
    gap: 20px;
    font-size: 12px;
    color: var(--text-dim);
  }
  .header-stats .val { color: var(--text); font-weight: 600; }
  .stale { color: var(--red) !important; font-weight: 700; }
  .demo-badge {
    background: var(--purple);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    padding: 2px 8px;
    border-radius: 4px;
    letter-spacing: 0.5px;
  }
  .progress-bar {
    width: 100%;
    height: 3px;
    background: var(--border);
    overflow: hidden;
  }
  .progress-bar .fill {
    height: 100%;
    background: linear-gradient(90deg, var(--cyan), var(--green));
    transition: width 0.3s ease;
  }
  .container { padding: 16px 24px; }
  .scan-status {
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .scan-status .dot {
    width: 8px; height: 8px;
    border-radius: 50%;
    background: var(--green);
    animation: pulse 1.5s infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 13px;
  }
  thead th {
    text-align: left;
    padding: 10px 12px;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
    border-bottom: 2px solid var(--border);
    position: sticky;
    top: 0;
    background: var(--bg);
  }
  tbody tr {
    border-bottom: 1px solid var(--border);
    transition: background 0.15s;
  }
  tbody tr:hover { background: rgba(6, 182, 212, 0.05); }
  td {
    padding: 10px 12px;
    white-space: nowrap;
  }
  .event-name {
    max-width: 340px;
    overflow: hidden;
    text-overflow: ellipsis;
    font-weight: 500;
  }
  .trade-badge {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 4px;
    background: rgba(6, 182, 212, 0.1);
    border: 1px solid rgba(6, 182, 212, 0.2);
    color: var(--cyan);
    font-weight: 600;
  }
  .price { font-variant-numeric: tabular-nums; }
  .profit-positive-high { color: var(--green-bright); font-weight: 700; }
  .profit-positive { color: var(--yellow); font-weight: 600; }
  .profit-marginal { color: var(--text-dim); }
  .profit-negative { color: #475569; }
  .match-score {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 3px;
    font-weight: 600;
  }
  .match-high { background: rgba(34,197,94,0.15); color: var(--green); }
  .match-mid { background: rgba(234,179,8,0.15); color: var(--yellow); }
  .match-low { background: rgba(100,116,139,0.15); color: var(--text-dim); }
  .empty-state {
    text-align: center;
    padding: 60px 20px;
    color: var(--text-dim);
  }
  .empty-state .icon { font-size: 36px; margin-bottom: 12px; }
  .empty-state p { font-size: 14px; }
  .footer {
    padding: 12px 24px;
    border-top: 1px solid var(--border);
    font-size: 11px;
    color: var(--text-dim);
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 8px;
  }
  .footer .best { color: var(--green); font-weight: 600; }
  @media (max-width: 768px) {
    .header { padding: 12px 16px; }
    .container { padding: 12px 8px; }
    table { font-size: 11px; }
    td, th { padding: 6px 6px; }
    .event-name { max-width: 160px; }
  }
</style>
</head>
<body>
  <div class="header">
    <div style="display:flex;align-items:center;gap:12px">
      <h1>POLYMARKET &harr; KALSHI ARB SCREENER</h1>
      <span class="demo-badge" id="demoBadge" style="display:none">DEMO</span>
    </div>
    <div class="header-stats">
      <span>Last scan: <span class="val" id="lastScan">--:--:--</span></span>
      <span>Matched: <span class="val" id="matchedPairs">0</span></span>
      <span>Poly: <span class="val" id="polyCount">0</span></span>
      <span>Kalshi: <span class="val" id="kalshiCount">0</span></span>
      <span id="polyStale"></span>
      <span id="kalshiStale"></span>
    </div>
  </div>
  <div class="progress-bar"><div class="fill" id="progressFill" style="width:0%"></div></div>
  <div class="container">
    <div class="scan-status">
      <div class="dot" id="dot"></div>
      <span id="scanPhase">Connecting...</span>
    </div>
    <table>
      <thead>
        <tr>
          <th>Event</th>
          <th>Trade</th>
          <th>Poly Ask</th>
          <th>Kalshi Ask</th>
          <th>Cost</th>
          <th>Profit</th>
          <th>Match</th>
          <th>Closes</th>
          <th>Est. Max $</th>
        </tr>
      </thead>
      <tbody id="tbody"></tbody>
    </table>
    <div class="empty-state" id="emptyState">
      <div class="icon">&#x1F50D;</div>
      <p>Scanning for arbitrage opportunities...</p>
    </div>
  </div>
  <div class="footer">
    <span>Cycle #<span id="cycle">0</span> &middot; Total opps: <span id="totalOpps">0</span></span>
    <span id="bestOpp">--</span>
    <span id="sessionTime">0m 0s</span>
  </div>
<script>
const $ = (id) => document.getElementById(id);

function fmt$(n) { return '$' + n.toFixed(2); }
function fmtPct(n) { return n.toFixed(1) + '%'; }
function fmtProfit(cents, pct) {
  const sign = cents >= 0 ? '+' : '';
  return sign + Math.round(cents * 100) + '¢ (' + fmtPct(pct) + ')';
}
function profitClass(pct) {
  if (pct > 5) return 'profit-positive-high';
  if (pct >= 1) return 'profit-positive';
  if (pct >= 0.8) return 'profit-marginal';
  return 'profit-negative';
}
function matchClass(score) {
  if (score >= 0.85) return 'match-high';
  if (score >= 0.75) return 'match-mid';
  return 'match-low';
}
function fmtTime(hours) {
  if (hours < 24) return hours.toFixed(1) + 'h';
  return Math.round(hours / 24) + 'd';
}
function fmtClock(d) {
  return new Date(d).toLocaleTimeString('en-US', { hour12: false });
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
}

function update(data) {
  $('lastScan').textContent = fmtClock(new Date());
  $('matchedPairs').textContent = data.matchedPairs.toLocaleString();
  $('polyCount').textContent = data.polymarketCount.toLocaleString();
  $('kalshiCount').textContent = data.kalshiCount.toLocaleString();
  $('scanPhase').textContent = data.scanPhase;
  $('progressFill').style.width = Math.round(data.scanProgress * 100) + '%';
  $('cycle').textContent = data.totalCycles;
  $('totalOpps').textContent = data.totalOpportunities;
  $('sessionTime').textContent = fmtDuration(Date.now() - new Date(data.startedAt).getTime());

  if (data.demoMode) $('demoBadge').style.display = 'inline';

  const ps = $('polyStale');
  const ks = $('kalshiStale');
  ps.textContent = data.polyStaleSeconds > 10 ? '[POLY STALE ' + Math.round(data.polyStaleSeconds) + 's]' : '';
  ps.className = data.polyStaleSeconds > 10 ? 'stale' : '';
  ks.textContent = data.kalshiStaleSeconds > 10 ? '[KALSHI STALE ' + Math.round(data.kalshiStaleSeconds) + 's]' : '';
  ks.className = data.kalshiStaleSeconds > 10 ? 'stale' : '';

  if (data.bestProfitPct !== null) {
    $('bestOpp').innerHTML = 'Best: <span class="best">+' + fmtPct(data.bestProfitPct) + '</span> on ' + (data.bestEvent || '').slice(0, 40);
  }

  const opps = data.opportunities || [];
  const tbody = $('tbody');
  const empty = $('emptyState');

  if (opps.length === 0) {
    tbody.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  let html = '';
  for (const o of opps) {
    const mc = matchClass(o.matchScore);
    const pc = profitClass(o.profitPctDisplay);
    html += '<tr>' +
      '<td class="event-name" title="' + o.event.replace(/"/g, '&quot;') + '">' + o.event.slice(0, 50) + '</td>' +
      '<td><span class="trade-badge">P:' + o.polymarketSide + ' + K:' + o.kalshiSide + '</span></td>' +
      '<td class="price">' + fmt$(o.polymarketAsk) + '</td>' +
      '<td class="price">' + fmt$(o.kalshiAsk) + '</td>' +
      '<td class="price">' + fmt$(o.combinedCost) + '</td>' +
      '<td class="' + pc + '">' + fmtProfit(o.profitPerContractDisplay, o.profitPctDisplay) + '</td>' +
      '<td><span class="match-score ' + mc + '">' + Math.round(o.matchScore * 100) + '%</span></td>' +
      '<td>' + fmtTime(o.timeToClose) + '</td>' +
      '<td>' + fmt$(o.estimatedMaxProfit) + '</td>' +
      '</tr>';
  }
  tbody.innerHTML = html;
}

// SSE connection with auto-reconnect
function connect() {
  const es = new EventSource('/api/events');
  $('dot').style.background = 'var(--green)';
  es.onmessage = (e) => {
    try { update(JSON.parse(e.data)); } catch {}
  };
  es.onerror = () => {
    $('dot').style.background = 'var(--red)';
    es.close();
    setTimeout(connect, 2000);
  };
}
connect();
</script>
</body>
</html>`;
