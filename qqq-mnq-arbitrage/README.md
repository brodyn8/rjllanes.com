# QQQ ↔ MNQ Statistical Arbitrage

Trade the spread between QQQ (ThinkOrSwim) and MNQ (NinjaTrader). Both tickers
track the Nasdaq-100, so their fair-value relationship is tight. When the futures
basis stretches beyond its rolling norm, fade it.

## How the signal works

```
spread     = MNQ_close − ratio × QQQ_close
ratio      = rolling least-squares fit of MNQ on QQQ (last N bars)
z          = (spread − mean_N(spread)) / stdev_N(spread)
```

Rolling-fit `ratio` self-calibrates as the QQQ divisor drifts and the futures
basis decays into expiration, so you don't have to hard-code 41.x.

## Rules

| | |
|---|---|
| Entry long spread  | `z ≤ −EntryZ` → BUY 1 MNQ, SELL ~80 QQQ |
| Entry short spread | `z ≥ +EntryZ` → SELL 1 MNQ, BUY ~80 QQQ |
| Exit               | `|z| ≤ ExitZ`, hard stop at `StopZ`, or time-stop |
| Session            | RTH only (09:30–15:55 ET). Flatten 5 min before close. |
| Size               | 1 MNQ per signal (fixed). QQQ hedge printed on TOS chart. |

Defaults: `Length=60`, `EntryZ=2.0`, `ExitZ=0.3`, `StopZ=3.5`, on 1-minute bars.

## Why each leg lives where it does

- **QQQ on ThinkOrSwim** — equity leg, easy to short borrow, paper-trade-able.
- **MNQ on NinjaTrader** — futures leg, low commissions, automatable via
  NinjaScript Strategy.

The two platforms don't talk to each other. Both run the **same z-score math on
the same bars**, so signals fire in sync. Run both during liquid hours, on
synchronized clocks.

## Backtester

`index.html` + `app.js` is a self-contained browser backtesting platform for this
strategy (live at [rjllanes.com/qqq-mnq-arbitrage](https://rjllanes.com/qqq-mnq-arbitrage/)).
It runs the same rolling-OLS / z-score math as the TOS and NT8 scripts.

- **Data**: bundled real Yahoo data (2y daily, 60d 30-min, 60d 5-min in `data.js`),
  a live-refresh button, or upload your own CSVs (NinjaTrader, TradingView, and
  Yahoo export formats are auto-detected). Both legs must share the bar interval
  and anchor; the Data Quality tab flags roll gaps, bad prints, and anchor skew.
- **Execution model**: fills at next bar open (NT-like) or signal-bar close,
  commissions + slippage per leg, NQ or MNQ contract specs.
- **Legs toggle**: backtest the hedged pair (futures + QQQ shares) or the naked
  futures leg — the latter is what `QqqMnqArbitrage.cs` actually trades, and the
  difference in drawdown is dramatic.
- **Parameter sweep**: lookback × entry-Z grid with net-P&L heatmap.
- **TradingView charting**: result charts render with TradingView Lightweight
  Charts (pan/zoom, synced crosshairs, trade markers; falls back to a built-in
  canvas renderer offline), and a "TradingView Live" tab embeds the real
  TradingView chart for NQ1!, MNQ1!, QQQ, and the NQ÷QQQ ratio.

Regenerate `data.js` with `python3 build_data.py` (fetches Yahoo's chart API
for QQQ and NQ=F at 1d/30m/5m and delta-encodes timestamps).

## Files

- `index.html`, `app.js`, `data.js` — the backtesting platform (above).
- `qqq_mnq_spread.ts` — ThinkScript study + strategy for TOS. Plots the spread,
  z-score, signal arrows, and the QQQ hedge size. Includes an optional
  AddOrder block to auto-trade the QQQ leg in paperMoney.
- `QqqMnqArbitrage.cs` — NinjaScript Strategy for NT8. Trades **1 MNQ** per
  signal using QQQ as a secondary data series. Drop into
  `Documents/NinjaTrader 8/bin/Custom/Strategies/` and compile (F5).

## Setup checklist

### ThinkOrSwim
1. Open a QQQ chart, 1-minute, RTH.
2. Studies → Edit Studies → Import → select `qqq_mnq_spread.ts`.
3. Apply to chart. Lower sub-graph shows z-score with ±EntryZ bands.
4. (Optional) Add as Strategy to backtest the QQQ leg.

### NinjaTrader 8
1. Copy `QqqMnqArbitrage.cs` into
   `Documents/NinjaTrader 8/bin/Custom/Strategies/`.
2. NT8 → New → NinjaScript Editor → F5 to compile.
3. **Data feed must include QQQ** (Kinetick EOD won't work intraday; use a
   provider with real-time equities, e.g. Kinetick Real-Time, IQFeed, or
   Rithmic + a secondary equity feed).
4. Open a 1-min MNQ chart (front month). Strategies → add
   `QqqMnqArbitrage` → set `EquitySymbol = "QQQ"` → Enable.

## Risk notes

- **Not true arbitrage.** The spread mean-reverts statistically, not by
  contractual link. Adverse moves can persist; the `StopZ` exit is mandatory.
- **Beta mismatch.** 1 MNQ ≈ $40k notional at NDX 20k. The "≈80 QQQ" hedge is
  approximate; recompute when QQQ moves a lot or when you change contracts.
- **Roll risk.** MNQ basis jumps at quarterly roll (Mar/Jun/Sep/Dec). Either
  pause the strategy for the roll week or use a continuous contract (`@MNQ`)
  for the signal and the front month for execution.
- **Latency.** Signals are bar-close. If TOS and NT clocks drift, one leg may
  fill before the other and you carry naked exposure for seconds. Acceptable
  on 1-min bars; not acceptable on tick-by-tick.
- **Paper-trade first.** Run both legs in sim for a full week before going
  live.
