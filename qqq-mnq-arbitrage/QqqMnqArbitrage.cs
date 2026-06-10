// QqqMnqArbitrage.cs
// NinjaTrader 8 Strategy. Trades 1 MNQ per signal against a QQQ-derived
// statistical spread. Mirrors the ThinkScript study qqq_mnq_spread.ts so
// signals fire on the same bars across both platforms.
//
// Install: copy to Documents/NinjaTrader 8/bin/Custom/Strategies/ and press
// F5 in the NinjaScript Editor. Run on a 1-minute MNQ chart (front month).
// Data feed must provide real-time QQQ (e.g. Kinetick Real-Time, IQFeed).

#region Using declarations
using System;
using System.ComponentModel;
using System.ComponentModel.DataAnnotations;
using NinjaTrader.Cbi;
using NinjaTrader.NinjaScript;
using NinjaTrader.NinjaScript.Strategies;
#endregion

namespace NinjaTrader.NinjaScript.Strategies
{
    public class QqqMnqArbitrage : Strategy
    {
        // ---- Parameters -----------------------------------------------------
        [NinjaScriptProperty]
        [Display(Name="Equity Symbol", Order=1, GroupName="Spread")]
        public string EquitySymbol { get; set; }

        [NinjaScriptProperty]
        [Range(10, 500)]
        [Display(Name="Lookback Length", Order=2, GroupName="Spread")]
        public int Length { get; set; }

        [NinjaScriptProperty]
        [Range(0.1, 5.0)]
        [Display(Name="Entry Z", Order=3, GroupName="Spread")]
        public double EntryZ { get; set; }

        [NinjaScriptProperty]
        [Range(0.0, 2.0)]
        [Display(Name="Exit Z", Order=4, GroupName="Spread")]
        public double ExitZ { get; set; }

        [NinjaScriptProperty]
        [Range(1.0, 10.0)]
        [Display(Name="Hard Stop Z", Order=5, GroupName="Spread")]
        public double StopZ { get; set; }

        [NinjaScriptProperty]
        [Display(Name="RTH Only", Order=6, GroupName="Session")]
        public bool RthOnly { get; set; }

        [NinjaScriptProperty]
        [Range(0, 60)]
        [Display(Name="Flatten N min before close", Order=7, GroupName="Session")]
        public int FlattenMinutesBeforeClose { get; set; }

        // ---- Constants ------------------------------------------------------
        private const int MnqSeries = 0;     // primary series (chart)
        private const int QqqSeries = 1;     // secondary

        protected override void OnStateChange()
        {
            if (State == State.SetDefaults)
            {
                Description                 = "QQQ-MNQ statistical spread arb. Trades 1 MNQ per signal.";
                Name                        = "QqqMnqArbitrage";
                Calculate                   = Calculate.OnBarClose;
                EntriesPerDirection         = 1;
                EntryHandling               = EntryHandling.AllEntries;
                IsExitOnSessionCloseStrategy= true;
                ExitOnSessionCloseSeconds   = 300;
                IsInstantiatedOnEachOptimizationIteration = true;

                EquitySymbol                = "QQQ";
                Length                      = 60;
                EntryZ                      = 2.0;
                ExitZ                       = 0.3;
                StopZ                       = 3.5;
                RthOnly                     = true;
                FlattenMinutesBeforeClose   = 5;
            }
            else if (State == State.Configure)
            {
                // QQQ as secondary series, same period as primary MNQ chart.
                AddDataSeries(EquitySymbol, BarsPeriod.BarsPeriodType, BarsPeriod.Value);
            }
        }

        protected override void OnBarUpdate()
        {
            // Wait until both series have enough bars.
            if (CurrentBars[MnqSeries] < Length || CurrentBars[QqqSeries] < Length)
                return;

            // Only act on close of the primary (MNQ) bar; secondary updates
            // arrive interleaved.
            if (BarsInProgress != MnqSeries) return;

            // ---- Rolling OLS: mnq = a + ratio * qqq ----
            double sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
            for (int i = 0; i < Length; i++)
            {
                double x = Closes[QqqSeries][i];
                double y = Closes[MnqSeries][i];
                sumX  += x;
                sumY  += y;
                sumXY += x * y;
                sumXX += x * x;
            }
            double n = Length;
            double denom = (n * sumXX) - (sumX * sumX);
            if (denom == 0) return;
            double ratio = ((n * sumXY) - (sumX * sumY)) / denom;
            double intercept = (sumY - ratio * sumX) / n;

            // ---- Rolling spread stats ----
            double mean = 0;
            double[] spreadHist = new double[Length];
            for (int i = 0; i < Length; i++)
            {
                spreadHist[i] = Closes[MnqSeries][i]
                                - (ratio * Closes[QqqSeries][i] + intercept);
                mean += spreadHist[i];
            }
            mean /= n;

            double variance = 0;
            for (int i = 0; i < Length; i++)
            {
                double d = spreadHist[i] - mean;
                variance += d * d;
            }
            double sigma = Math.Sqrt(variance / n);
            if (sigma == 0) return;

            double currentSpread = spreadHist[0];
            double z = (currentSpread - mean) / sigma;

            // ---- Session filter ----
            bool inSession = !RthOnly || IsInRth();

            // ---- Position management ----
            bool flat = Position.MarketPosition == MarketPosition.Flat;
            bool longMnq  = Position.MarketPosition == MarketPosition.Long;
            bool shortMnq = Position.MarketPosition == MarketPosition.Short;

            // Hard stop / exit-to-flat / session exit
            if (!flat && (Math.Abs(z) <= ExitZ
                          || Math.Abs(z) >= StopZ
                          || !inSession))
            {
                if (longMnq)  ExitLong("FlatLong",   "LongSpread");
                if (shortMnq) ExitShort("FlatShort", "ShortSpread");
                Print(string.Format(
                    "{0:HH:mm} EXIT z={1:F2} spread={2:F2} ratio={3:F3}",
                    Time[0], z, currentSpread, ratio));
                return;
            }

            if (!inSession || !flat) return;

            // ---- Entries ----
            // z below -EntryZ  => spread is rich-cheap (MNQ cheap vs QQQ) => LONG MNQ
            // z above +EntryZ  => MNQ rich vs QQQ                         => SHORT MNQ
            if (z <= -EntryZ)
            {
                EnterLong(1, "LongSpread");
                Print(string.Format(
                    "{0:HH:mm} ENTRY LONG  MNQ z={1:F2} spread={2:F2} ratio={3:F3} -> hedge ~{4} QQQ short",
                    Time[0], z, currentSpread, ratio, HedgeShares()));
            }
            else if (z >= EntryZ)
            {
                EnterShort(1, "ShortSpread");
                Print(string.Format(
                    "{0:HH:mm} ENTRY SHORT MNQ z={1:F2} spread={2:F2} ratio={3:F3} -> hedge ~{4} QQQ long",
                    Time[0], z, currentSpread, ratio, HedgeShares()));
            }
        }

        private bool IsInRth()
        {
            // 09:30:00 .. 16:00:00 - FlattenMinutesBeforeClose, exchange time
            DateTime t = Time[0];
            var open  = new DateTime(t.Year, t.Month, t.Day, 9, 30, 0);
            var close = new DateTime(t.Year, t.Month, t.Day, 16, 0, 0)
                            .AddMinutes(-FlattenMinutesBeforeClose);
            return t >= open && t <= close;
        }

        // Approximate hedge size for log/print only. MNQ point value = $2.
        private int HedgeShares()
        {
            double mnqPx = Closes[MnqSeries][0];
            double qqqPx = Closes[QqqSeries][0];
            if (qqqPx <= 0) return 0;
            return (int)Math.Round(mnqPx * 2.0 / qqqPx);
        }
    }
}
