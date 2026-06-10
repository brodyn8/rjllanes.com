#!/usr/bin/env python3
"""Rebuild data.js for the QQQ/NQ arbitrage backtester.

Fetches QQQ and NQ=F bars from Yahoo Finance's chart API at three intervals
(2y daily, 60d 30-minute, 60d 5-minute) and writes them as a compact,
delta-encoded bundle. 30-minute is used instead of hourly because Yahoo
anchors equity hourly bars at :30 and futures at :00, which breaks alignment.

Usage:  python3 build_data.py
"""
import json, datetime, urllib.request, pathlib

UA = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"}
SPECS = [("1d", "2y", "1d"), ("30m", "60d", "30m"), ("5m", "60d", "5m")]
SYMBOLS = {"qqq": "QQQ", "nq": "NQ=F"}
OUT = pathlib.Path(__file__).parent / "data.js"


def fetch(symbol, rng, interval):
    url = (f"https://query1.finance.yahoo.com/v8/finance/chart/"
           f"{urllib.parse.quote(symbol)}?range={rng}&interval={interval}")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30) as r:
        raw = json.load(r)
    res = raw["chart"]["result"][0]
    ts, q = res["timestamp"], res["indicators"]["quote"][0]
    t, o, c = [], [], []
    for i, tt in enumerate(ts):
        cl = q["close"][i]
        if cl is None:
            continue
        op = q["open"][i] if q["open"][i] is not None else cl
        t.append(int(tt)); o.append(round(float(op), 2)); c.append(round(float(cl), 2))
    return t, o, c


def delta(ts):
    out, prev = [], 0
    for t in ts:
        out.append(t - prev); prev = t
    return out


def main():
    sets = {}
    for key, rng, interval in SPECS:
        legs = {}
        for name, sym in SYMBOLS.items():
            t, o, c = fetch(sym, rng, interval)
            legs[name] = {"t": delta(t), "o": o, "c": c}
            print(f"{key} {sym}: {len(t)} bars, "
                  f"{datetime.datetime.fromtimestamp(t[0]):%Y-%m-%d} → "
                  f"{datetime.datetime.fromtimestamp(t[-1]):%Y-%m-%d}")
        sets[key] = legs
    bundle = {"asOf": datetime.date.today().isoformat(),
              "source": "Yahoo Finance (QQQ, NQ=F continuous)", "sets": sets}
    js = ("// Bundled historical data for the QQQ/NQ arbitrage backtester.\n"
          "// Regenerate with build_data.py. Timestamps are delta-encoded epoch seconds.\n"
          "window.ARB_DATA = " + json.dumps(bundle, separators=(",", ":")) + ";\n")
    OUT.write_text(js)
    print(f"wrote {OUT} ({len(js) // 1024} KB)")


if __name__ == "__main__":
    main()
