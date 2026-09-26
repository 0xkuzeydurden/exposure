// Every threshold behind the per-finding classifications and the one-line diagnosis (plan §5).
// One file, no per-token tuning; the README documents each value. Shares are fractions (0.005 = 0.5%).
// Key names are shared with lib/xray/pipeline/active-rules.ts; rename there too.

export const T = {
  /** Rule 0 "Too few labelled wallets to read this token." fires only when ALL three hold. */
  insufficient: {
    /** Holders' cost basis covers less than this share of circulating supply (WallsFinding.analyzedSupplyShare). */
    analysedSupply: 0.25,
    /** Fewer than this many top buyers could be analysed (BuyersFinding.topBuyers). */
    buyers: 10,
    // ...and no labelled (smart money / whale / public figure / exchange) flow was seen this week.
  },

  /** Finding 01 · demand. ratio = independent sources / traced buyers (exchange- or bridge-funded buyers count one each). */
  demand: {
    /** ORGANIC needs ratio >= 0.6 ... */
    organicRatio: 0.6,
    /** ... and the largest non-exchange source below 20% of analysed buy volume. */
    organicMaxSourceShare: 0.2,
    /** CONCENTRATED when one non-exchange source did >= 35% of analysed buy volume ... */
    concentratedSourceShare: 0.35,
    /** ... or ratio < 0.35. Anything in between is MIXED. */
    concentratedRatio: 0.35,
    /** No funder tracing (Solana, quick tier): the top 10 buyers did >= 70% of the week's buying => CONCENTRATED. */
    top10Concentrated: 0.7,
    /** No funder tracing: top-10 share below 50% => ORGANIC (pipeline addition, not in plan §5; else MIXED). */
    top10Organic: 0.5,
  },

  /** Finding 02 · flow of informed money (smart money + whales + public figures, aggregated). */
  flow: {
    /**
     * |7-day informed net flow| as a share of market cap (or of circulating supply when market cap is unknown).
     * <= -0.5% with fresh/unlabelled wallets net buying => DISTRIBUTING; >= +0.5% => ACCUMULATING; else QUIET.
     */
    moveShare: 0.005,
    /** Net inflow to exchanges >= 0.3% of supply adds the note "moved onto exchanges". */
    exchangeNoteShare: 0.003,
  },

  /** Finding 03 · ceiling. HEAVY when any one holds, else LIGHT. */
  ceiling: {
    /** Only walls up to +30% above the price count as "just above". */
    nearMovePct: 0.3,
    /** Such a wall worth >= 1.5x the pool's liquidity ... */
    wallToLiquidity: 1.5,
    /** ... or holding >= 8% of the analysed supply ... */
    wallShareOfAnalysed: 0.08,
    /** ... or >= 60% of the analysed supply is underwater (cost above today's price). */
    underwaterShare: 0.6,
  },

  /** Finding 04 · smart money (aggregated over >= 30 days, never per wallet). */
  smart: {
    /** PROFIT when price >= 1.1x the average entry. */
    profitMultiple: 1.1,
    /** LOSS when price < 0.9x the average entry; in between is BREAKEVEN. */
    lossMultiple: 0.9,
    /** Stance from net / gross USD flow over the window: >= +0.15 ADDING ... */
    addingRatio: 0.15,
    /** ... <= -0.15 TRIMMING ... */
    trimmingRatio: -0.15,
    /** ... <= -0.5 EXITING; otherwise HOLDING. */
    exitingRatio: -0.5,
    /**
     * Fewer smart-money wallets than this are never shown (their "aggregate" would be one wallet's own
     * numbers). Same value as SMART_MIN_WALLETS in lib/xray/pipeline/smart.ts.
     */
    minWallets: 3,
  },

  /** Rules 2 and 3: the 7-day price change below which the price "fell" (unknown counts as not fallen). */
  price: {
    fellBelow: 0,
  },

  /** Confidence = the lowest coverage among the findings the fired rule used. */
  confidence: {
    /** HIGH at >= 60% coverage. */
    high: 0.6,
    /** MEDIUM at 30-60%; LOW below. */
    medium: 0.3,
    /** Smart-money coverage = wallets / 10, capped at 1 (10+ smart wallets = full coverage). */
    smartFullWallets: 10,
    /** Flow coverage: 1 when every labelled cohort answered, 0.5 when some did (status "partial"). */
    flowPartial: 0.5,
  },

  /** Report wording only (never changes the diagnosis). */
  copy: {
    /** Finding 01 adds "N% of them could not be traced." at or above this untraced share. */
    untracedNote: 0.25,
    /** Finding 02 says informed money "barely moved" below this |net| share of supply. */
    quietFlow: 0.0005,
  },
} as const;

export type Thresholds = typeof T;
