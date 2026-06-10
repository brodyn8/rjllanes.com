/* QQQ / NQ statistical-arbitrage backtester.
 * Signal math mirrors QqqMnqArbitrage.cs / qqq_mnq_spread.ts:
 *   rolling OLS fit  nq = a + b*qqq  over the last N bars,
 *   z = residual / stdev(residuals); fade |z| beyond EntryZ back to ExitZ.
 * Engine functions are pure so they can be exercised in Node for testing.
 */
"use strict";

/* ============================ data decoding ============================ */

function decodeLeg(leg) {
  const t = new Array(leg.t.length);
  let acc = 0;
  for (let i = 0; i < leg.t.length; i++) { acc += leg.t[i]; t[i] = acc; }
  return { t, o: leg.o, c: leg.c };
}

function decodeSets(bundle) {
  const out = {};
  for (const k of Object.keys(bundle.sets)) {
    out[k] = { qqq: decodeLeg(bundle.sets[k].qqq), nq: decodeLeg(bundle.sets[k].nq) };
  }
  return out;
}

/* ============================ alignment ============================ */

let _nyDateFmt = null;
function nyDateKey(epochSec) {
  if (typeof Intl === "undefined") { // node fallback: UTC-5 approx is fine for daily keys
    return new Date((epochSec - 5 * 3600) * 1000).toISOString().slice(0, 10);
  }
  if (!_nyDateFmt) _nyDateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" });
  return _nyDateFmt.format(new Date(epochSec * 1000));
}

function medianDt(t) {
  if (t.length < 2) return 86400;
  const d = [];
  for (let i = 1; i < Math.min(t.length, 500); i++) d.push(t[i] - t[i - 1]);
  d.sort((a, b) => a - b);
  return d[Math.floor(d.length / 2)];
}

/** Inner-join two legs. Daily data joins on NY calendar date, intraday on epoch.
 * If exact epoch join matches poorly (bar anchors differ between sources, e.g.
 * 9:30-anchored vs :00-anchored hourly bars), falls back to a bucket join and
 * flags the result so the UI can warn that closes are time-skewed. */
function alignSeries(qqq, nq) {
  const dt = Math.min(medianDt(qqq.t), medianDt(nq.t));
  const daily = dt >= 70000;
  const join = (key) => {
    const nqIdx = new Map();
    for (let j = 0; j < nq.t.length; j++) nqIdx.set(key(nq.t[j]), j);
    const t = [], q = [], n = [], qo = [], no = [];
    for (let i = 0; i < qqq.t.length; i++) {
      const j = nqIdx.get(key(qqq.t[i]));
      if (j === undefined) continue;
      t.push(qqq.t[i]); q.push(qqq.c[i]); n.push(nq.c[j]);
      qo.push(qqq.o[i]); no.push(nq.o[j]);
    }
    return { t, q, n, qo, no };
  };
  let skewJoin = false;
  let r = join(daily ? nyDateKey : (s) => s);
  if (!daily && r.t.length < 0.3 * Math.min(qqq.t.length, nq.t.length)) {
    r = join((s) => Math.floor(s / dt));
    skewJoin = true;
  }
  return Object.assign(r, { daily, dt, skewJoin, rawQ: qqq.t.length, rawN: nq.t.length });
}

/* ============================ signal series ============================ */

/** Rolling spread stats. Returns {z, ratio, intercept, spread, sigma} arrays (NaN before warm-up). */
function computeSignal(al, length, model) {
  const m = al.t.length;
  const z = new Float64Array(m).fill(NaN);
  const ratio = new Float64Array(m).fill(NaN);
  const intercept = new Float64Array(m).fill(NaN);
  const spread = new Float64Array(m).fill(NaN);
  const sigmaA = new Float64Array(m).fill(NaN);
  let sX = 0, sY = 0, sXX = 0, sYY = 0, sXY = 0, sR = 0;
  for (let i = 0; i < m; i++) {
    const x = al.q[i], y = al.n[i];
    sX += x; sY += y; sXX += x * x; sYY += y * y; sXY += x * y; sR += y / x;
    if (i >= length) {
      const xo = al.q[i - length], yo = al.n[i - length];
      sX -= xo; sY -= yo; sXX -= xo * xo; sYY -= yo * yo; sXY -= xo * yo; sR -= yo / xo;
    }
    if (i < length - 1) continue;
    const N = length;
    if (model === "ols") {
      const Sxx = sXX - sX * sX / N, Sxy = sXY - sX * sY / N, Syy = sYY - sY * sY / N;
      if (Sxx <= 0) continue;
      const b = Sxy / Sxx, a = (sY - b * sX) / N;
      const sse = Math.max(0, Syy - b * Sxy);
      const sig = Math.sqrt(sse / N);
      const resid = y - (a + b * x);
      ratio[i] = b; intercept[i] = a; spread[i] = resid; sigmaA[i] = sig;
      if (sig > 0) z[i] = resid / sig;
    } else { // rolling mean ratio
      const r = sR / N;
      const meanS = (sY - r * sX) / N;
      const eS2 = (sYY - 2 * r * sXY + r * r * sXX) / N;
      const v = Math.max(0, eS2 - meanS * meanS);
      const sig = Math.sqrt(v);
      const sp = y - r * x;
      ratio[i] = r; intercept[i] = 0; spread[i] = sp - meanS; sigmaA[i] = sig;
      if (sig > 0) z[i] = (sp - meanS) / sig;
    }
  }
  return { z, ratio, intercept, spread, sigma: sigmaA };
}

/* ============================ backtest engine ============================ */

const CONTRACTS = {
  NQ:  { pointValue: 20, tickSize: 0.25 },
  MNQ: { pointValue: 2,  tickSize: 0.25 },
};

function lastBarOfDayFlags(t, daily) {
  const m = t.length, flags = new Uint8Array(m);
  if (daily) return flags; // no intraday flatten on daily bars
  for (let i = 0; i < m; i++) {
    flags[i] = (i === m - 1 || nyDateKey(t[i + 1]) !== nyDateKey(t[i])) ? 1 : 0;
  }
  return flags;
}

function runBacktest(al, P) {
  const sig = computeSignal(al, P.length, P.model);
  const m = al.t.length;
  const spec = CONTRACTS[P.contract];
  const pv = spec.pointValue, tick = spec.tickSize;
  const eod = (P.rthOnly && !al.daily) ? lastBarOfDayFlags(al.t, al.daily) : new Uint8Array(m);

  const futSideCost = (P.futComm + P.futSlipTicks * tick * pv) * P.qty;
  const eqSideCostPerShare = P.eqComm + P.eqSlipCents / 100;

  const trades = [];
  const equity = new Float64Array(m);
  let realized = 0;
  let pos = 0;             // +1 long fut / short QQQ, -1 short fut / long QQQ
  let entry = null;        // {i, fut, qqq, shares, z}
  let pending = null;      // {action:'enter'|'exit', dir, z, reason} fills next open
  let cooldownLeft = 0;

  const openTrade = (i, dir, fut, qqq, zIn) => {
    const shares = P.legs === "both" ? Math.round(fut * pv * P.qty / qqq) : 0;
    pos = dir;
    entry = { i, fut, qqq, shares, z: zIn, cost: futSideCost + shares * eqSideCostPerShare };
  };
  const closeTrade = (i, fut, qqq, zOut, reason) => {
    const dir = pos, e = entry;
    const futPnl = dir * (fut - e.fut) * pv * P.qty;
    const hedgePnl = -dir * (qqq - e.qqq) * e.shares;
    const costs = e.cost + futSideCost + e.shares * eqSideCostPerShare;
    const net = futPnl + hedgePnl - costs;
    trades.push({
      side: dir, iIn: e.i, iOut: i, tIn: al.t[e.i], tOut: al.t[i],
      zIn: e.z, zOut, futIn: e.fut, futOut: fut, qIn: e.qqq, qOut: qqq,
      shares: e.shares, futPnl, hedgePnl, costs, net, reason, bars: i - e.i,
    });
    realized += net;
    pos = 0; entry = null;
    if (reason === "stop" && P.cooldown > 0) cooldownLeft = P.cooldown;
  };
  const unreal = (i) => {
    if (!pos) return 0;
    return pos * (al.n[i] - entry.fut) * pv * P.qty - pos * (al.q[i] - entry.qqq) * entry.shares;
  };

  for (let i = 0; i < m; i++) {
    // 1. fill pending order at this bar's open (next-open exec mode)
    if (pending) {
      // never open a position on the day's last bar — it would flatten the same
      // bar at the session close and only pay costs
      if (pending.action === "enter" && !pos && !eod[i] && i < m - 1) {
        openTrade(i, pending.dir, al.no[i], al.qo[i], pending.z);
      } else if (pending.action === "exit" && pos) {
        closeTrade(i, al.no[i], al.qo[i], pending.z, pending.reason);
      }
      pending = null;
    }

    const z = sig.z[i];
    const lastBar = i === m - 1;

    // 2. decide on this bar's close
    if (!isNaN(z)) {
      if (pos) {
        let reason = null;
        if (Math.abs(z) >= P.stopZ) reason = "stop";
        else if (Math.abs(z) <= P.exitZ) reason = "target";
        else if (P.maxBars > 0 && i - entry.i >= P.maxBars) reason = "time";
        if (eod[i]) reason = "session";
        if (lastBar) reason = reason || "eod";
        if (reason) {
          if (P.exec === "close" || reason === "session" || lastBar) {
            closeTrade(i, al.n[i], al.q[i], z, reason);
          } else pending = { action: "exit", z, reason };
        }
      } else if (cooldownLeft > 0) {
        cooldownLeft--;
      } else if (!eod[i] && !lastBar && !pending) {
        let dir = 0;
        if (z <= -P.entryZ) dir = +1;       // NQ cheap vs QQQ → long fut, short QQQ
        else if (z >= P.entryZ) dir = -1;   // NQ rich vs QQQ → short fut, long QQQ
        if (dir) {
          if (P.exec === "close") openTrade(i, dir, al.n[i], al.q[i], z);
          else pending = { action: "enter", dir, z };
        }
      }
    } else if (pos && (eod[i] || lastBar)) {
      closeTrade(i, al.n[i], al.q[i], NaN, lastBar ? "eod" : "session");
    }

    // 3. mark to market
    equity[i] = realized + unreal(i);
  }

  return { trades, equity, sig, al, P };
}

/* ============================ metrics ============================ */

function computeMetrics(res) {
  const { trades, equity, al, P } = res;
  const m = al.t.length;
  const net = trades.reduce((s, t) => s + t.net, 0);
  const costs = trades.reduce((s, t) => s + t.costs, 0);
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => t.net <= 0);
  const sumW = wins.reduce((s, t) => s + t.net, 0);
  const sumL = losses.reduce((s, t) => s + t.net, 0);

  let peak = 0, maxDD = 0;
  for (let i = 0; i < m; i++) {
    if (equity[i] > peak) peak = equity[i];
    const dd = peak - equity[i];
    if (dd > maxDD) maxDD = dd;
  }

  // Sharpe from per-bar equity changes scaled by capital
  let prev = 0, sum = 0, sum2 = 0, cnt = 0;
  for (let i = 0; i < m; i++) {
    const r = (equity[i] - prev) / P.capital;
    prev = equity[i];
    sum += r; sum2 += r * r; cnt++;
  }
  const mean = sum / cnt;
  const sd = Math.sqrt(Math.max(0, sum2 / cnt - mean * mean));
  const barsPerYear = al.daily ? 252 : (252 * 6.5 * 3600) / al.dt;
  const sharpe = sd > 0 ? (mean / sd) * Math.sqrt(barsPerYear) : 0;

  const barsIn = trades.reduce((s, t) => s + t.bars, 0);
  return {
    net, costs, gross: net + costs,
    nTrades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    profitFactor: sumL < 0 ? sumW / -sumL : (sumW > 0 ? Infinity : 0),
    avgTrade: trades.length ? net / trades.length : 0,
    avgWin: wins.length ? sumW / wins.length : 0,
    avgLoss: losses.length ? sumL / losses.length : 0,
    maxDD, maxDDPct: maxDD / P.capital,
    retPct: net / P.capital,
    sharpe,
    exposure: m ? barsIn / m : 0,
    avgBars: trades.length ? barsIn / trades.length : 0,
  };
}

/* ============================ data quality ============================ */

function qualityReport(al) {
  const issues = [];
  for (let i = 1; i < al.t.length; i++) {
    const rq = Math.log(al.q[i] / al.q[i - 1]);
    const rn = Math.log(al.n[i] / al.n[i - 1]);
    const div = Math.abs(rn - rq);
    if (div > 0.004) issues.push({ i, t: al.t[i], div, rq, rn });
  }
  issues.sort((a, b) => b.div - a.div);
  const gaps = [];
  for (let i = 1; i < al.t.length; i++) gaps.push({ i, t: al.t[i], gap: al.t[i] - al.t[i - 1] });
  gaps.sort((a, b) => b.gap - a.gap);
  return { issues: issues.slice(0, 12), gaps: gaps.slice(0, 5) };
}

/* ============================ CSV parsing ============================ */

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length);
  if (!lines.length) throw new Error("empty file");
  const first = lines[0];
  const delim = [";", ",", "\t"].map((d) => [d, first.split(d).length])
    .sort((a, b) => b[1] - a[1])[0][0];
  const hasHeader = /[A-Za-z]{2,}/.test(first.split(delim)[0]) || /close|last|open|date|time/i.test(first);
  let tCol = 0, oCol = -1, cCol = -1, start = 0;
  if (hasHeader) {
    start = 1;
    const h = first.split(delim).map((s) => s.trim().toLowerCase().replace(/['"]/g, ""));
    tCol = h.findIndex((c) => /^(date.?time|timestamp|time|date)$/.test(c));
    if (tCol < 0) tCol = 0;
    cCol = h.findIndex((c) => /^(close|last|adj ?close|price)$/.test(c));
    oCol = h.findIndex((c) => /^open$/.test(c));
  } else {
    const cols = first.split(delim).length;
    // NinjaTrader: ts;O;H;L;C;V → close = col 4; two-column files = t,c
    cCol = cols >= 5 ? 4 : cols - 1;
    oCol = cols >= 5 ? 1 : -1;
  }
  if (cCol < 0) throw new Error("no Close/Last column found");
  const t = [], o = [], c = [];
  for (let i = start; i < lines.length; i++) {
    const parts = lines[i].split(delim);
    const ts = parseTimestamp(parts[tCol]);
    const cl = parseFloat(parts[cCol]);
    if (ts === null || !isFinite(cl)) continue;
    const op = oCol >= 0 ? parseFloat(parts[oCol]) : cl;
    t.push(ts); o.push(isFinite(op) ? op : cl); c.push(cl);
  }
  if (t.length < 10) throw new Error("fewer than 10 valid rows parsed");
  if (t[0] > t[t.length - 1]) { t.reverse(); o.reverse(); c.reverse(); }
  return { t, o, c };
}

function parseTimestamp(s) {
  if (s === undefined) return null;
  s = String(s).trim().replace(/['"]/g, "");
  if (/^\d{10}$/.test(s)) return parseInt(s, 10);
  if (/^\d{13}$/.test(s)) return Math.floor(parseInt(s, 10) / 1000);
  let mm = s.match(/^(\d{4})(\d{2})(\d{2})[ T]?(\d{2})?(\d{2})?(\d{2})?$/); // NinjaTrader yyyyMMdd HHmmss
  if (mm) {
    return Math.floor(new Date(+mm[1], +mm[2] - 1, +mm[3], +(mm[4] || 0), +(mm[5] || 0), +(mm[6] || 0)).getTime() / 1000);
  }
  const d = Date.parse(s);
  if (!isNaN(d)) return Math.floor(d / 1000);
  return null;
}

/* ============================ node export ============================ */

if (typeof module !== "undefined" && module.exports) {
  module.exports = { decodeSets, alignSeries, computeSignal, runBacktest, computeMetrics, qualityReport, parseCsv, CONTRACTS };
}
if (typeof document === "undefined") {
  // running headless — skip all UI wiring below
} else {

/* ============================ UI ============================ */

const $ = (id) => document.getElementById(id);
const SETS = decodeSets(window.ARB_DATA);
let csvData = { qqq: null, nq: null };
let lastRes = null, lastMet = null;

const fmt$ = (v) => (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString("en-US", { maximumFractionDigits: 0 });
const fmt2 = (v) => isFinite(v) ? v.toFixed(2) : "—";
const fmtPct = (v) => (v * 100).toFixed(1) + "%";
const fmtTime = (s, daily) => {
  const d = new Date(s * 1000);
  const opts = daily ? { timeZone: "America/New_York", month: "short", day: "numeric", year: "2-digit" }
    : { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false };
  return d.toLocaleString("en-US", opts);
};

function getParams() {
  return {
    length: Math.max(10, +$("p-length").value | 0),
    model: $("p-model").value,
    entryZ: +$("p-entryz").value,
    exitZ: +$("p-exitz").value,
    stopZ: +$("p-stopz").value,
    maxBars: +$("p-maxbars").value | 0,
    cooldown: +$("p-cooldown").value | 0,
    rthOnly: $("p-rth").checked,
    contract: $("p-contract").value,
    qty: Math.max(1, +$("p-qty").value | 0),
    legs: $("p-legs").value,
    exec: $("p-exec").value,
    futComm: +$("p-futcomm").value,
    futSlipTicks: +$("p-futslip").value,
    eqComm: +$("p-eqcomm").value,
    eqSlipCents: +$("p-eqslip").value,
    capital: Math.max(1000, +$("p-capital").value),
  };
}

function currentLegs() {
  const k = $("dataset").value;
  if (k === "csv") {
    if (!csvData.qqq || !csvData.nq) return null;
    return csvData;
  }
  return SETS[k];
}

function runAndRender() {
  const legs = currentLegs();
  if (!legs) { alert("Upload both CSV files first (QQQ and NQ)."); return; }
  const al = alignSeries(legs.qqq, legs.nq);
  if (al.t.length < 50) { alert("Fewer than 50 aligned bars — check that both files cover the same period/interval."); return; }
  const P = getParams();
  if (al.t.length <= P.length + 5) { alert("Lookback is too long for this dataset."); return; }
  lastRes = runBacktest(al, P);
  lastMet = computeMetrics(lastRes);
  renderKpis(lastMet, P);
  renderSignalPanel(lastRes);
  renderCharts(lastRes);
  renderTrades(lastRes);
  renderQuality(al);
}

/* ---------- KPIs ---------- */
function renderKpis(met, P) {
  const cls = (v) => v > 0 ? "pos" : v < 0 ? "neg" : "neu";
  const items = [
    ["Net P&L", fmt$(met.net), cls(met.net)],
    ["Return", fmtPct(met.retPct), cls(met.retPct)],
    ["Trades", met.nTrades, ""],
    ["Win rate", fmtPct(met.winRate), met.winRate >= 0.5 ? "pos" : "neu"],
    ["Profit factor", isFinite(met.profitFactor) ? fmt2(met.profitFactor) : "∞", met.profitFactor >= 1 ? "pos" : "neg"],
    ["Avg trade", fmt$(met.avgTrade), cls(met.avgTrade)],
    ["Max drawdown", fmt$(-met.maxDD) + " (" + fmtPct(met.maxDDPct) + ")", "neg"],
    ["Sharpe", fmt2(met.sharpe), cls(met.sharpe)],
    ["Total costs", fmt$(met.costs), "neu"],
    ["Gross P&L", fmt$(met.gross), cls(met.gross)],
  ];
  $("kpis").innerHTML = items.map(([l, v, c]) =>
    `<div class="kpi"><div class="l">${l}</div><div class="v ${c}">${v}</div></div>`).join("");
}

/* ---------- latest signal ---------- */
function renderSignalPanel(res) {
  const { sig, al, P } = res;
  let i = al.t.length - 1;
  while (i > 0 && isNaN(sig.z[i])) i--;
  if (isNaN(sig.z[i])) return;
  const z = sig.z[i], r = sig.ratio[i];
  const spec = CONTRACTS[P.contract];
  const shares = Math.round(al.n[i] * spec.pointValue * P.qty / al.q[i]);
  let verdict, color;
  if (z >= P.entryZ) { verdict = `${P.contract} RICH vs QQQ → SHORT ${P.qty} ${P.contract} / LONG ~${shares} QQQ`; color = "var(--red)"; }
  else if (z <= -P.entryZ) { verdict = `${P.contract} CHEAP vs QQQ → LONG ${P.qty} ${P.contract} / SHORT ~${shares} QQQ`; color = "var(--green)"; }
  else { verdict = `inside equilibrium band (|z| < ${P.entryZ}) — no trade`; color = "var(--amber)"; }
  $("signal-panel").style.display = "block";
  $("signal-panel").style.borderLeftColor = color;
  $("signal-body").innerHTML =
    `${fmtTime(al.t[i], al.daily)} ET &nbsp;·&nbsp; NQ ${al.n[i].toFixed(2)} / QQQ ${al.q[i].toFixed(2)} &nbsp;·&nbsp; ` +
    `hedge ratio ${r.toFixed(3)} &nbsp;·&nbsp; deviation z = <b style="color:${color}">${z >= 0 ? "+" : ""}${z.toFixed(2)}σ</b><br>` +
    `<span style="color:${color}">${verdict}</span>`;
}

/* ============================ canvas charts ============================ */

function setupCanvas(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = +cv.getAttribute("height");
  cv.width = w * dpr; cv.height = h * dpr;
  cv.style.height = h + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

const PADL = 52, PADR = 10, PADT = 8, PADB = 20;

function makeScale(min, max, h) {
  if (min === max) { min -= 1; max += 1; }
  const pad = (max - min) * 0.07;
  min -= pad; max += pad;
  return { min, max, y: (v) => PADT + (1 - (v - min) / (max - min)) * (h - PADT - PADB) };
}

function niceTicks(min, max, n = 5) {
  const span = max - min, step0 = span / n;
  const mag = Math.pow(10, Math.floor(Math.log10(step0)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => span / s <= n + 1) || mag * 10;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(v);
  return out;
}

/** generic chart: cfg {series:[{data,color,width}], hlines, markers, fillToZero, t, daily, readoutEl, label} */
function drawChart(cv, cfg) {
  const { ctx, w, h } = setupCanvas(cv);
  const m = cfg.t.length;
  const x = (i) => PADL + (i / Math.max(1, m - 1)) * (w - PADL - PADR);

  let lo = Infinity, hi = -Infinity;
  for (const s of cfg.series) for (let i = 0; i < m; i++) {
    const v = s.data[i];
    if (isNaN(v)) continue;
    if (v < lo) lo = v; if (v > hi) hi = v;
  }
  for (const hl of cfg.hlines || []) { if (hl.y < lo) lo = hl.y; if (hl.y > hi) hi = hl.y; }
  if (!isFinite(lo)) { lo = 0; hi = 1; }
  const sc = makeScale(lo, hi, h);

  const render = (hoverI) => {
    ctx.clearRect(0, 0, w, h);
    // grid + y labels
    ctx.font = "10px DM Mono, monospace";
    ctx.fillStyle = "#5a6478"; ctx.strokeStyle = "#1d2433"; ctx.lineWidth = 1;
    for (const tv of niceTicks(sc.min, sc.max)) {
      const yy = sc.y(tv);
      ctx.beginPath(); ctx.moveTo(PADL, yy); ctx.lineTo(w - PADR, yy); ctx.stroke();
      ctx.textAlign = "right";
      ctx.fillText(Math.abs(tv) >= 1000 ? (tv / 1000).toFixed(1) + "k" : +tv.toFixed(2) + "", PADL - 6, yy + 3);
    }
    // x labels (≈6)
    ctx.textAlign = "center";
    const nLab = Math.min(6, m);
    for (let k = 0; k < nLab; k++) {
      const i = Math.floor((k / Math.max(1, nLab - 1)) * (m - 1));
      const d = new Date(cfg.t[i] * 1000);
      const lab = cfg.daily || m > 2000
        ? d.toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", year: m > 400 ? "2-digit" : undefined })
        : d.toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
      ctx.fillText(lab, x(i), h - 5);
    }
    // hlines
    for (const hl of cfg.hlines || []) {
      ctx.strokeStyle = hl.color; ctx.lineWidth = 1;
      ctx.setLineDash(hl.dash || []);
      const yy = sc.y(hl.y);
      ctx.beginPath(); ctx.moveTo(PADL, yy); ctx.lineTo(w - PADR, yy); ctx.stroke();
      ctx.setLineDash([]);
    }
    // series — decimated to pixel columns (min/max envelope)
    const cols = Math.max(2, Math.floor(w - PADL - PADR));
    for (const s of cfg.series) {
      ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 1.4;
      ctx.beginPath();
      let started = false;
      if (m <= cols * 2) {
        for (let i = 0; i < m; i++) {
          const v = s.data[i];
          if (isNaN(v)) continue;
          const px = x(i), py = sc.y(v);
          if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
        }
      } else {
        for (let cI = 0; cI < cols; cI++) {
          const i0 = Math.floor((cI / cols) * m), i1 = Math.max(i0 + 1, Math.floor(((cI + 1) / cols) * m));
          let mn = Infinity, mx = -Infinity;
          for (let i = i0; i < i1 && i < m; i++) {
            const v = s.data[i];
            if (isNaN(v)) continue;
            if (v < mn) mn = v; if (v > mx) mx = v;
          }
          if (!isFinite(mn)) continue;
          const px = PADL + (cI / cols) * (w - PADL - PADR);
          if (!started) { ctx.moveTo(px, sc.y(mn)); started = true; }
          ctx.lineTo(px, sc.y(mx)); ctx.lineTo(px, sc.y(mn));
        }
      }
      ctx.stroke();
      if (s.fillToZero) {
        ctx.lineTo(x(m - 1), sc.y(0)); ctx.lineTo(x(0), sc.y(0)); ctx.closePath();
        ctx.fillStyle = s.fillToZero; ctx.fill();
      }
    }
    // drawdown shading (equity chart)
    if (cfg.ddSeries) {
      ctx.fillStyle = "rgba(255,93,108,0.22)";
      let peak = -Infinity;
      ctx.beginPath();
      let started = false;
      for (let i = 0; i < m; i++) {
        const v = cfg.ddSeries[i];
        if (v > peak) peak = v;
        const yTop = sc.y(peak), yBot = sc.y(v);
        if (!started) { ctx.moveTo(x(i), yTop); started = true; }
        ctx.lineTo(x(i), yTop);
      }
      for (let i = m - 1; i >= 0; i--) ctx.lineTo(x(i), sc.y(cfg.ddSeries[i] !== undefined ? cfg.ddSeries[i] : 0));
      ctx.closePath();
      // recompute running peak for top edge correctness — simpler: skip if heavy
      ctx.fill();
    }
    // markers
    for (const mk of cfg.markers || []) {
      const px = x(mk.i), py = sc.y(mk.y);
      ctx.fillStyle = mk.color; ctx.strokeStyle = mk.color;
      if (mk.type === "up") { ctx.beginPath(); ctx.moveTo(px, py + 7); ctx.lineTo(px - 5, py + 14); ctx.lineTo(px + 5, py + 14); ctx.closePath(); ctx.fill(); }
      else if (mk.type === "down") { ctx.beginPath(); ctx.moveTo(px, py - 7); ctx.lineTo(px - 5, py - 14); ctx.lineTo(px + 5, py - 14); ctx.closePath(); ctx.fill(); }
      else { ctx.lineWidth = 1.6; ctx.beginPath(); ctx.moveTo(px - 4, py - 4); ctx.lineTo(px + 4, py + 4); ctx.moveTo(px + 4, py - 4); ctx.lineTo(px - 4, py + 4); ctx.stroke(); }
    }
    // crosshair
    if (hoverI !== undefined && hoverI >= 0 && hoverI < m) {
      ctx.strokeStyle = "rgba(139,151,171,0.45)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(x(hoverI), PADT); ctx.lineTo(x(hoverI), h - PADB); ctx.stroke();
      ctx.setLineDash([]);
    }
  };

  render();

  cv.onmousemove = (ev) => {
    const r = cv.getBoundingClientRect();
    const fx = (ev.clientX - r.left - PADL) / (r.width - PADL - PADR);
    const i = Math.max(0, Math.min(m - 1, Math.round(fx * (m - 1))));
    render(i);
    if (cfg.readoutEl && cfg.readout) cfg.readoutEl.textContent = cfg.readout(i);
  };
  cv.onmouseleave = () => { render(); if (cfg.readoutEl) cfg.readoutEl.textContent = ""; };
}

/** Dispatcher: TradingView Lightweight Charts when the library loaded,
 * otherwise the built-in canvas renderer (offline fallback). */
let chartMode = null;
function renderCharts(res) {
  if (window.LightweightCharts) { chartMode = "tv"; renderChartsTV(res); }
  else { chartMode = "canvas"; renderChartsCanvas(res); }
}

/* ---------- TradingView Lightweight Charts renderer ---------- */

// Lightweight Charts has no timezone support; shift epochs so axis labels read as ET.
let _offFmt = null;
const _offCache = new Map();
function nyShift(sec) {
  const day = Math.floor(sec / 86400);
  let off = _offCache.get(day);
  if (off === undefined) {
    if (!_offFmt) _offFmt = new Intl.DateTimeFormat("en-US", {
      timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
    });
    const p = {};
    for (const x of _offFmt.formatToParts(new Date(sec * 1000))) p[x.type] = x.value;
    off = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) / 1000 - sec;
    _offCache.set(day, off);
  }
  return sec + off;
}

let tvCharts = [];
const TV_OPTS = {
  autoSize: true,
  layout: { background: { color: "transparent" }, textColor: "#8b97ab", fontSize: 11, fontFamily: "DM Mono, monospace" },
  grid: { vertLines: { color: "#1d2433" }, horzLines: { color: "#1d2433" } },
  rightPriceScale: { borderColor: "#252e40" },
  timeScale: { borderColor: "#252e40", timeVisible: true, secondsVisible: false },
  crosshair: { mode: 0 },
};

function tvContainer(id) {
  const el = $(id);
  el.style.display = "block";
  const cv = el.parentElement.querySelector("canvas");
  if (cv) cv.style.display = "none";
  el.innerHTML = "";
  return el;
}

function renderChartsTV(res) {
  const { al, sig, equity, trades, P } = res;
  const m = al.t.length;
  for (const c of tvCharts) c.remove();
  tvCharts = [];

  const times = new Array(m);
  for (let i = 0; i < m; i++) times[i] = nyShift(al.t[i]);
  const timeToIdx = new Map();
  for (let i = 0; i < m; i++) timeToIdx.set(times[i], i);

  const mkChart = (id) => {
    const ch = LightweightCharts.createChart(tvContainer(id), TV_OPTS);
    tvCharts.push(ch);
    return ch;
  };
  const hookReadout = (ch, el, fn) => {
    ch.subscribeCrosshairMove((param) => {
      const i = param && param.time !== undefined ? timeToIdx.get(param.time) : undefined;
      el.textContent = i === undefined ? "" : fn(i);
    });
  };

  // 1. prices, normalized to 100
  const chP = mkChart("tv-price");
  const qd = [], nd = [];
  for (let i = 0; i < m; i++) {
    qd.push({ time: times[i], value: (al.q[i] / al.q[0]) * 100 });
    nd.push({ time: times[i], value: (al.n[i] / al.n[0]) * 100 });
  }
  chP.addLineSeries({ color: "#5b9cff", lineWidth: 2, priceLineVisible: false, lastValueVisible: false }).setData(qd);
  chP.addLineSeries({ color: "#b07cff", lineWidth: 2, priceLineVisible: false, lastValueVisible: false }).setData(nd);
  hookReadout(chP, $("ro-price"), (i) =>
    `${fmtTime(al.t[i], al.daily)} ET   QQQ ${al.q[i].toFixed(2)}   NQ ${al.n[i].toFixed(2)}   NQ/QQQ ${(al.n[i] / al.q[i]).toFixed(3)}`);

  // 2. z-score with bands + trade markers
  const chZ = mkChart("tv-z");
  const zd = [];
  for (let i = 0; i < m; i++) if (!isNaN(sig.z[i])) zd.push({ time: times[i], value: sig.z[i] });
  const zs = chZ.addLineSeries({
    color: "#ffb84d", lineWidth: 1, priceLineVisible: false, lastValueVisible: true,
    priceFormat: { type: "price", precision: 2, minMove: 0.01 },
  });
  zs.setData(zd);
  const band = (y, color, style) => zs.createPriceLine({ price: y, color, lineWidth: 1, lineStyle: style, axisLabelVisible: false });
  const LS = LightweightCharts.LineStyle;
  band(0, "#3a445a", LS.Solid);
  band(P.entryZ, "rgba(91,156,255,0.8)", LS.Dashed); band(-P.entryZ, "rgba(91,156,255,0.8)", LS.Dashed);
  band(P.stopZ, "rgba(255,93,108,0.8)", LS.Dotted);  band(-P.stopZ, "rgba(255,93,108,0.8)", LS.Dotted);
  const markers = [];
  for (const tr of trades) {
    markers.push(tr.side > 0
      ? { time: times[tr.iIn], position: "belowBar", shape: "arrowUp", color: "#2ecc8f", text: "L" }
      : { time: times[tr.iIn], position: "aboveBar", shape: "arrowDown", color: "#ff5d6c", text: "S" });
    markers.push({ time: times[tr.iOut], position: "aboveBar", shape: "circle",
      color: tr.reason === "stop" ? "#ff5d6c" : "#8b97ab", size: 0.6 });
  }
  markers.sort((a, b) => a.time - b.time);
  zs.setMarkers(markers);
  hookReadout(chZ, $("ro-z"), (i) => isNaN(sig.z[i])
    ? `${fmtTime(al.t[i], al.daily)} ET   warming up`
    : `${fmtTime(al.t[i], al.daily)} ET   z ${sig.z[i].toFixed(2)}   ratio ${sig.ratio[i].toFixed(3)}   spread ${sig.spread[i].toFixed(2)} pts   σ ${sig.sigma[i].toFixed(2)}`);

  // 3. equity
  const chE = mkChart("tv-eq");
  const ed = [];
  for (let i = 0; i < m; i++) ed.push({ time: times[i], value: equity[i] });
  const es = chE.addAreaSeries({
    lineColor: "#2ecc8f", lineWidth: 2, topColor: "rgba(46,204,143,0.25)", bottomColor: "rgba(46,204,143,0.02)",
    priceLineVisible: false, priceFormat: { type: "price", precision: 0, minMove: 1 },
  });
  es.setData(ed);
  es.createPriceLine({ price: 0, color: "#3a445a", lineWidth: 1, lineStyle: LS.Solid, axisLabelVisible: false });
  hookReadout(chE, $("ro-eq"), (i) => `${fmtTime(al.t[i], al.daily)} ET   equity ${fmt$(equity[i])}`);

  // keep the three time scales in lockstep
  let syncing = false;
  for (const ch of tvCharts) {
    ch.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (syncing || !r) return;
      syncing = true;
      for (const o of tvCharts) if (o !== ch) o.timeScale().setVisibleLogicalRange(r);
      syncing = false;
    });
  }
  for (const ch of tvCharts) ch.timeScale().fitContent();
}

/* ---------- built-in canvas renderer (offline fallback) ---------- */

function renderChartsCanvas(res) {
  const { al, sig, equity, trades, P } = res;
  const m = al.t.length;
  for (const id of ["tv-price", "tv-z", "tv-eq"]) {
    const el = $(id);
    el.style.display = "none";
    const cv = el.parentElement.querySelector("canvas");
    if (cv) cv.style.display = "block";
  }

  // price chart, normalized
  const qn = new Float64Array(m), nn = new Float64Array(m);
  for (let i = 0; i < m; i++) { qn[i] = (al.q[i] / al.q[0]) * 100; nn[i] = (al.n[i] / al.n[0]) * 100; }
  drawChart($("ch-price"), {
    t: al.t, daily: al.daily,
    series: [{ data: qn, color: "#5b9cff" }, { data: nn, color: "#b07cff" }],
    readoutEl: $("ro-price"),
    readout: (i) => `${fmtTime(al.t[i], al.daily)} ET   QQQ ${al.q[i].toFixed(2)}   NQ ${al.n[i].toFixed(2)}   NQ/QQQ ${(al.n[i] / al.q[i]).toFixed(3)}`,
  });

  // z chart with bands and trade markers
  const markers = [];
  for (const tr of trades) {
    markers.push({ i: tr.iIn, y: isNaN(tr.zIn) ? 0 : tr.zIn, type: tr.side > 0 ? "up" : "down", color: tr.side > 0 ? "#2ecc8f" : "#ff5d6c" });
    markers.push({ i: tr.iOut, y: isNaN(tr.zOut) ? 0 : tr.zOut, type: "x", color: tr.reason === "stop" ? "#ff5d6c" : "#8b97ab" });
  }
  drawChart($("ch-z"), {
    t: al.t, daily: al.daily,
    series: [{ data: sig.z, color: "#ffb84d", width: 1.2 }],
    hlines: [
      { y: 0, color: "#3a445a" },
      { y: P.entryZ, color: "rgba(91,156,255,0.8)", dash: [5, 4] },
      { y: -P.entryZ, color: "rgba(91,156,255,0.8)", dash: [5, 4] },
      { y: P.stopZ, color: "rgba(255,93,108,0.8)", dash: [2, 3] },
      { y: -P.stopZ, color: "rgba(255,93,108,0.8)", dash: [2, 3] },
    ],
    markers,
    readoutEl: $("ro-z"),
    readout: (i) => isNaN(sig.z[i]) ? `${fmtTime(al.t[i], al.daily)} ET   warming up`
      : `${fmtTime(al.t[i], al.daily)} ET   z ${sig.z[i].toFixed(2)}   ratio ${sig.ratio[i].toFixed(3)}   spread ${sig.spread[i].toFixed(2)} pts   σ ${sig.sigma[i].toFixed(2)}`,
  });

  // equity
  drawChart($("ch-eq"), {
    t: al.t, daily: al.daily,
    series: [{ data: equity, color: "#2ecc8f", width: 1.6 }],
    hlines: [{ y: 0, color: "#3a445a" }],
    ddSeries: equity,
    readoutEl: $("ro-eq"),
    readout: (i) => `${fmtTime(al.t[i], al.daily)} ET   equity ${fmt$(equity[i])}`,
  });
}

/* ---------- trades table ---------- */
function renderTrades(res) {
  const { trades, al } = res;
  const tb = $("trades-table").querySelector("tbody");
  const reasonName = { target: "target", stop: "STOP", time: "time", session: "session", eod: "end of data" };
  tb.innerHTML = trades.map((t, k) => `
    <tr>
      <td>${k + 1}</td>
      <td><span class="tag ${t.side > 0 ? "long" : "short"}">${t.side > 0 ? "LONG fut" : "SHORT fut"}</span></td>
      <td>${fmtTime(t.tIn, al.daily)}</td>
      <td>${fmtTime(t.tOut, al.daily)}</td>
      <td>${t.bars}</td>
      <td>${isNaN(t.zIn) ? "—" : t.zIn.toFixed(2)}</td>
      <td>${isNaN(t.zOut) ? "—" : t.zOut.toFixed(2)}</td>
      <td class="exit-${t.reason}">${reasonName[t.reason] || t.reason}</td>
      <td class="${t.futPnl >= 0 ? "pos" : "neg"}">${fmt$(t.futPnl)}</td>
      <td class="${t.hedgePnl >= 0 ? "pos" : "neg"}">${t.shares ? fmt$(t.hedgePnl) : "—"}</td>
      <td class="neu">${fmt$(t.costs)}</td>
      <td class="${t.net >= 0 ? "pos" : "neg"}"><b>${fmt$(t.net)}</b></td>
    </tr>`).join("");
  const n = trades.length;
  const net = trades.reduce((s, t) => s + t.net, 0);
  $("trades-summary").textContent = n ? `${n} trades, ${fmt$(net)} net` : "No trades generated — try a lower Entry Z or longer dataset.";
}

function exportTradesCsv() {
  if (!lastRes || !lastRes.trades.length) return;
  const head = "num,side,entry_time,exit_time,bars,z_in,z_out,reason,fut_entry,fut_exit,qqq_entry,qqq_exit,hedge_shares,fut_pnl,hedge_pnl,costs,net";
  const rows = lastRes.trades.map((t, k) => [
    k + 1, t.side > 0 ? "long_fut" : "short_fut",
    new Date(t.tIn * 1000).toISOString(), new Date(t.tOut * 1000).toISOString(),
    t.bars, t.zIn.toFixed(3), isNaN(t.zOut) ? "" : t.zOut.toFixed(3), t.reason,
    t.futIn, t.futOut, t.qIn, t.qOut, t.shares,
    t.futPnl.toFixed(2), t.hedgePnl.toFixed(2), t.costs.toFixed(2), t.net.toFixed(2),
  ].join(","));
  const blob = new Blob([head + "\n" + rows.join("\n")], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "qqq_nq_arb_trades.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ---------- parameter sweep ---------- */
function runSweep() {
  const legs = currentLegs();
  if (!legs) { alert("Load data first."); return; }
  const al = alignSeries(legs.qqq, legs.nq);
  const base = getParams();
  const lengths = $("sweep-lengths").value.split(",").map((s) => parseInt(s.trim(), 10)).filter((v) => v >= 10);
  const entries = $("sweep-entries").value.split(",").map((s) => parseFloat(s.trim())).filter((v) => v > 0);
  if (!lengths.length || !entries.length) return;
  const cells = [];
  let best = -Infinity, worst = Infinity;
  for (const L of lengths) {
    const row = [];
    for (const E of entries) {
      if (al.t.length <= L + 5) { row.push(null); continue; }
      const P = Object.assign({}, base, { length: L, entryZ: E });
      const res = runBacktest(al, P);
      const met = computeMetrics(res);
      row.push(met);
      if (met.net > best) best = met.net;
      if (met.net < worst) worst = met.net;
    }
    cells.push(row);
  }
  const scale = Math.max(Math.abs(best), Math.abs(worst)) || 1;
  let html = '<table class="sweep-table"><thead><tr><th>Lookback ↓ \\ Entry Z →</th>' +
    entries.map((e) => `<th>${e.toFixed(1)}</th>`).join("") + "</tr></thead><tbody>";
  cells.forEach((row, ri) => {
    html += `<tr><td><b>${lengths[ri]}</b></td>`;
    row.forEach((met, ci) => {
      if (!met) { html += "<td>—</td>"; return; }
      const a = Math.min(0.55, Math.abs(met.net) / scale * 0.55);
      const bgc = met.net >= 0 ? `rgba(46,204,143,${a})` : `rgba(255,93,108,${a})`;
      html += `<td style="background:${bgc}" data-l="${lengths[ri]}" data-e="${entries[ci]}" ` +
        `title="${met.nTrades} trades, PF ${isFinite(met.profitFactor) ? met.profitFactor.toFixed(2) : "∞"}, win ${fmtPct(met.winRate)}">` +
        `${fmt$(met.net)}<br><span style="color:var(--faint);font-size:10px">${met.nTrades} tr</span></td>`;
    });
    html += "</tr>";
  });
  html += "</tbody></table>";
  $("sweep-out").innerHTML = html;
  $("sweep-out").querySelectorAll("td[data-l]").forEach((td) => {
    td.addEventListener("click", () => {
      $("p-length").value = td.dataset.l;
      $("p-entryz").value = td.dataset.e;
      runAndRender();
      document.querySelector('[data-tab="trades"]').click();
    });
  });
}

/* ---------- quality ---------- */
function renderQuality(al) {
  const q = qualityReport(al);
  const dtName = al.daily ? "daily" : al.dt >= 3600 ? (al.dt / 3600) + "h" : (al.dt / 60) + "min";
  let html = `Aligned <b>${al.t.length}</b> bars (${dtName}) from ${al.rawQ} QQQ / ${al.rawN} NQ raw bars · ` +
    `${fmtTime(al.t[0], true)} → ${fmtTime(al.t[al.t.length - 1], true)}<br><br>`;
  if (al.skewJoin) {
    html += `<span class="warn">⚠ The two files use different bar anchors (e.g. 9:30-anchored vs :00-anchored). ` +
      `Bars were matched by time bucket, so closes are up to ${Math.round(al.dt / 60)} min apart — the spread/z-score ` +
      `partly measures lag, not mispricing. Re-export both legs on the same anchor for trustworthy results.</span><br><br>`;
  }
  if (q.issues.length) {
    html += `<span class="warn">⚠ ${q.issues.length >= 12 ? "12+" : q.issues.length} bars where NQ and QQQ returns diverged &gt;0.4% — ` +
      `likely futures roll gaps or bad prints. The z-score is distorted for ~1 lookback window after each:</span><br>`;
    html += q.issues.map((x) => `&nbsp;&nbsp;${fmtTime(x.t, al.daily)} ET — divergence ${(x.div * 100).toFixed(2)}% (NQ ${(x.rn * 100).toFixed(2)}% vs QQQ ${(x.rq * 100).toFixed(2)}%)`).join("<br>") + "<br><br>";
  } else {
    html += `<span class="pos">✓ No return divergences &gt;0.4% between legs — no obvious roll gaps or bad prints.</span><br><br>`;
  }
  html += "Largest time gaps (weekends/holidays expected):<br>" +
    q.gaps.map((g) => `&nbsp;&nbsp;${fmtTime(g.t, al.daily)} ET — ${(g.gap / 3600).toFixed(1)}h since prior bar`).join("<br>");
  $("quality-out").innerHTML = html;
}

/* ---------- Yahoo refresh ---------- */
const YAHOO_SPEC = { "1d": ["2y", "1d"], "30m": ["60d", "30m"], "5m": ["60d", "5m"] };
async function refreshFromYahoo() {
  const k = $("dataset").value;
  if (k === "csv") { $("fetch-status").textContent = "Select a bundled dataset to refresh."; return; }
  const [range, interval] = YAHOO_SPEC[k];
  const status = $("fetch-status");
  status.style.color = "var(--dim)";
  const proxies = [
    (u) => "https://corsproxy.io/?url=" + encodeURIComponent(u),
    (u) => "https://api.allorigins.win/raw?url=" + encodeURIComponent(u),
  ];
  const yurl = (sym) => `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${range}&interval=${interval}`;
  const grab = async (sym) => {
    let err;
    for (const p of proxies) {
      try {
        status.textContent = `Fetching ${sym} (${interval})…`;
        const r = await fetch(p(yurl(sym)), { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const j = await r.json();
        const res = j.chart.result[0];
        const qt = res.indicators.quote[0];
        const t = [], o = [], c = [];
        for (let i = 0; i < res.timestamp.length; i++) {
          if (qt.close[i] == null) continue;
          t.push(res.timestamp[i]); o.push(qt.open[i] == null ? qt.close[i] : qt.open[i]); c.push(qt.close[i]);
        }
        if (t.length < 10) throw new Error("no data");
        return { t, o, c };
      } catch (e) { err = e; }
    }
    throw err || new Error("all proxies failed");
  };
  try {
    const [qqq, nq] = [await grab("QQQ"), await grab("NQ=F")];
    SETS[k] = { qqq, nq };
    status.style.color = "var(--green)";
    status.textContent = `✓ Live data loaded (${qqq.c.length} QQQ / ${nq.c.length} NQ bars). Re-running…`;
    runAndRender();
  } catch (e) {
    status.style.color = "var(--red)";
    status.textContent = "✗ Fetch failed (" + (e.message || e) + "). CORS proxies are flaky — bundled data still loaded, or upload CSVs.";
  }
}

/* ---------- live TradingView embed ---------- */
let _tvScript = null, _tvEmbedSym = null;
function loadTvScript() {
  if (!_tvScript) {
    _tvScript = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://s3.tradingview.com/tv.js";
      s.onload = resolve;
      s.onerror = () => { _tvScript = null; reject(new Error("tv.js failed to load")); };
      document.head.appendChild(s);
    });
  }
  return _tvScript;
}

async function showTvEmbed(sym) {
  const box = $("tv-embed");
  try { await loadTvScript(); }
  catch (e) {
    box.innerHTML = '<div class="note" style="padding:20px">Could not load TradingView (offline or blocked by the network).</div>';
    return;
  }
  if (_tvEmbedSym === sym) return;
  _tvEmbedSym = sym;
  box.innerHTML = "";
  new TradingView.widget({
    container_id: "tv-embed",
    symbol: sym,
    interval: "30",
    timezone: "America/New_York",
    theme: "dark",
    style: "1",
    locale: "en",
    autosize: true,
    allow_symbol_change: true,
    withdateranges: true,
  });
}

document.querySelectorAll(".tv-sym").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".tv-sym").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    showTvEmbed(b.dataset.sym);
  });
});

/* ---------- wiring ---------- */
function updateDatasetUi() {
  const k = $("dataset").value;
  $("csv-zone").style.display = k === "csv" ? "block" : "none";
  $("bundled-info").textContent = k === "csv" ? "" :
    `Real ${window.ARB_DATA.source} data, bundled ${window.ARB_DATA.asOf}.`;
}

$("dataset").addEventListener("change", () => { updateDatasetUi(); if ($("dataset").value !== "csv") runAndRender(); });
$("btn-run").addEventListener("click", runAndRender);
$("btn-export").addEventListener("click", exportTradesCsv);
$("btn-sweep").addEventListener("click", runSweep);
$("btn-refresh").addEventListener("click", refreshFromYahoo);

for (const [id, side] of [["file-qqq", "qqq"], ["file-nq", "nq"]]) {
  $(id).addEventListener("change", async (ev) => {
    const f = ev.target.files[0];
    if (!f) return;
    const st = $("csv-status");
    try {
      csvData[side] = parseCsv(await f.text());
      st.style.color = "var(--green)";
      st.textContent = `✓ ${side.toUpperCase()}: ${csvData[side].t.length} bars loaded.` +
        (csvData.qqq && csvData.nq ? " Running…" : " Now load the other leg.");
      if (csvData.qqq && csvData.nq) runAndRender();
    } catch (e) {
      csvData[side] = null;
      st.style.color = "var(--red)";
      st.textContent = `✗ ${f.name}: ${e.message}`;
    }
  });
}

document.querySelectorAll(".tabs button").forEach((b) => {
  b.addEventListener("click", () => {
    document.querySelectorAll(".tabs button").forEach((x) => x.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    $("tab-" + b.dataset.tab).classList.add("active");
    if (b.dataset.tab === "tvlive") {
      const active = document.querySelector(".tv-sym.active");
      showTvEmbed(active ? active.dataset.sym : "NASDAQ:QQQ");
    }
  });
});

let _rsz;
window.addEventListener("resize", () => {
  // Lightweight Charts auto-sizes itself; only the canvas fallback needs a redraw
  if (chartMode !== "canvas") return;
  clearTimeout(_rsz); _rsz = setTimeout(() => lastRes && renderCharts(lastRes), 150);
});

updateDatasetUi();
runAndRender();

} // end browser-only block
