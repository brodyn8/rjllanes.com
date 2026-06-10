# QQQ <-> MNQ Spread Z-Score
# ThinkScript study + strategy for ThinkOrSwim.
# Apply to a QQQ chart, 1-minute, RTH.
#
# Signal logic mirrors the NinjaScript side (QqqMnqArbitrage.cs) so both
# platforms fire on the same bars.

declare lower;

input MnqSymbol      = "/MNQ:XCME";   # change to front month if you prefer
input Length         = 60;             # rolling window for fit + z-score
input EntryZ         = 2.0;
input ExitZ          = 0.3;
input StopZ          = 3.5;
input MnqContracts   = 1;              # size assumption for hedge calc
input PointValueMNQ  = 2.0;            # $ per MNQ point
input ShowHedgeSize  = yes;
input RthOnly        = yes;
input FlattenMinutesBeforeClose = 5;

# ---- Inputs from both instruments -------------------------------------------
def qqq = close;
def mnq = close(symbol = MnqSymbol);

# ---- Rolling OLS: mnq = a + ratio * qqq -------------------------------------
def n = Length;
def sumX  = Sum(qqq, n);
def sumY  = Sum(mnq, n);
def sumXY = Sum(qqq * mnq, n);
def sumXX = Sum(qqq * qqq, n);
def denom = (n * sumXX) - (sumX * sumX);
def ratio = if denom == 0 then Double.NaN else ((n * sumXY) - (sumX * sumY)) / denom;
def intercept = (sumY - ratio * sumX) / n;

def spread   = mnq - (ratio * qqq + intercept);
def mu       = Average(spread, n);
def sigma    = StDev(spread, n);
def z        = if sigma == 0 then 0 else (spread - mu) / sigma;

# ---- Plots ------------------------------------------------------------------
plot ZScore = z;
ZScore.SetDefaultColor(Color.CYAN);
ZScore.SetLineWeight(2);

plot UpperEntry = EntryZ;
plot LowerEntry = -EntryZ;
plot UpperStop  = StopZ;
plot LowerStop  = -StopZ;
plot Zero       = 0;

UpperEntry.SetDefaultColor(Color.RED);
LowerEntry.SetDefaultColor(Color.GREEN);
UpperStop.SetDefaultColor(Color.DARK_RED);
LowerStop.SetDefaultColor(Color.DARK_GREEN);
UpperStop.SetStyle(Curve.SHORT_DASH);
LowerStop.SetStyle(Curve.SHORT_DASH);
Zero.SetDefaultColor(Color.GRAY);
Zero.SetStyle(Curve.SHORT_DASH);

# ---- Session filter ---------------------------------------------------------
def inRth = if !RthOnly then 1
            else if SecondsFromTime(0930) >= 0
                 and SecondsTillTime(1600 - FlattenMinutesBeforeClose * 60 / 60) > 0
            then 1 else 0;
# Simpler RTH gate (TOS-safe):
def secsFromOpen  = SecondsFromTime(0930);
def secsToClose   = SecondsTillTime(1600);
def session = secsFromOpen >= 0 and secsToClose > FlattenMinutesBeforeClose * 60;

# ---- Signals (cross logic) --------------------------------------------------
def longSpreadEntry  = session and z crosses below -EntryZ;
def shortSpreadEntry = session and z crosses above  EntryZ;
def exitFlat         = AbsValue(z) <= ExitZ;
def hardStop         = AbsValue(z) >= StopZ;
def sessionExit      = !session;

# ---- Arrows on the z-score sub-graph ----------------------------------------
plot LongArrow  = if longSpreadEntry  then -EntryZ else Double.NaN;
plot ShortArrow = if shortSpreadEntry then  EntryZ else Double.NaN;
LongArrow.SetPaintingStrategy(PaintingStrategy.ARROW_UP);
LongArrow.SetDefaultColor(Color.GREEN);
LongArrow.SetLineWeight(3);
ShortArrow.SetPaintingStrategy(PaintingStrategy.ARROW_DOWN);
ShortArrow.SetDefaultColor(Color.RED);
ShortArrow.SetLineWeight(3);

# ---- QQQ hedge size readout -------------------------------------------------
# 1 MNQ notional = MNQ_price * PointValueMNQ. Hedge shares = notional / QQQ.
def hedgeShares = if qqq == 0 then 0 else Round(MnqContracts * mnq * PointValueMNQ / qqq, 0);

AddLabel(ShowHedgeSize,
    "Spread: " + Round(spread, 2) +
    "   z: "  + Round(z, 2) +
    "   ratio: " + Round(ratio, 3) +
    "   QQQ hedge per " + MnqContracts + " MNQ: " + hedgeShares + " sh",
    if AbsValue(z) >= EntryZ then Color.YELLOW else Color.LIGHT_GRAY);

# =============================================================================
# Optional Strategy block — auto-trades the QQQ hedge leg in paperMoney.
# Comment out if you only want the indicator.
# =============================================================================
AddOrder(OrderType.BUY_TO_OPEN,  longSpreadEntry  and !IsNaN(hedgeShares),
         price = close, tradeSize = hedgeShares,
         name = "QQQ_LongSpread");
AddOrder(OrderType.SELL_TO_CLOSE, (exitFlat or hardStop or sessionExit),
         price = close, name = "QQQ_LongExit");

AddOrder(OrderType.SELL_TO_OPEN, shortSpreadEntry and !IsNaN(hedgeShares),
         price = close, tradeSize = hedgeShares,
         name = "QQQ_ShortSpread");
AddOrder(OrderType.BUY_TO_CLOSE, (exitFlat or hardStop or sessionExit),
         price = close, name = "QQQ_ShortExit");
