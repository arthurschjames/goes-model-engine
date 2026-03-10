// ─── Model Engine v2 ───────────────────────────────────────────────────────
// Pure financial model logic — no React, no UI.
// Implements GOES-to-Transformer financial model per SPEC_v2 + Addendum v2.

// ─── IRR Solver (Newton-Raphson) ────────────────────────────────────────────
export function calculateIRR(cashflows, guess = 0.12) {
  let rate = guess;
  for (let i = 0; i < 2000; i++) {
    let npv = 0, dnpv = 0;
    for (let t = 0; t < cashflows.length; t++) {
      const d = Math.pow(1 + rate, t);
      npv += cashflows[t] / d;
      dnpv -= t * cashflows[t] / (d * (1 + rate));
    }
    if (Math.abs(npv) < 0.01) return rate;
    if (Math.abs(dnpv) < 1e-12) return null;
    const next = rate - npv / dnpv;
    if (next < -0.95 || next > 5 || isNaN(next)) return null;
    rate = next;
  }
  return null;
}

// ─── Formatting Helpers ─────────────────────────────────────────────────────
export const fmt = (v, d = 0) => {
  if (v == null || isNaN(v)) return "—";
  const neg = v < 0;
  const s = Math.abs(v).toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `(${s})` : s;
};
export const fmtM = (v) => `$${fmt(Math.round(v), 0)}M`;
export const fmtPct = (v) => `${fmt(v * 100, 1)}%`;

// ─── Constants ──────────────────────────────────────────────────────────────
export const NAMEPLATE = 180000;
export const DOD_TONS = 10600;
export const DOD_PRICE = 7550;
export const DOE_CAPACITY = 25000;
export const DOE_TARGET_SAVINGS = 80; // $M/yr at full NAMEPLATE — $80M / 180Kt ≈ $444/ton
export const DOE_SAVINGS_PER_TON = DOE_TARGET_SAVINGS * 1e6 / NAMEPLATE; // ~$444.44/ton
export const DOE_RAMP_YEARS = 2; // linear ramp from doeYear over 2 years
// OVERHEAD_BASE removed — overhead is now overheadPct (% of revenue)
export const FIXED_COST_SHARE = 0.35; // ~35% of production cost is fixed (labor, maintenance, facility)
export const TAX_RATE = 0.25;
export const DOE_GRANT_AMOUNT = 75; // $M
export const INTERNALIZE_FACTOR_DEFAULT = 0.50; // configurable via internalizeFactor input
export const DUOPOLY_TRANSITION_YEARS = 4; // Nippon ramps over 4 years, gradually compressing prices

// ─── Info Tooltips (re-exported from infoTooltips.js) ─────────────────────
// Display-only content — kept separate from model logic.
// Re-exported here for backward compatibility with any external consumers.
export { INFO } from "./infoTooltips.js";

// ─── Base Defaults (all inputs) ─────────────────────────────────────────────
const BASE = {
  // Steel Mill — utilization ramp (start → target over rampYears)
  goesStartUtil: 0.70, goesTargetUtil: 0.92, goesRampYears: 2,
  goesPrice: 5600, duopolyImpact: 0.17,
  goesProductionCost: 2800, nipponYear: 5, dodOn: true, dodRenewal: true,
  doeOn: false, doeYear: 1,
  goesPriceInflation: 0.035,
  overheadPct: 0.07, // SGA/overhead as % of Steel Mill revenue (replaces fixed $M)
  nonGoesRevenue: 120, nonGoesMargin: 0.15,
  // TX Existing Business — $500M MPT company acquisition
  txExistEnabled: true, txExistStartYear: 1,
  txBaseRevenue: 500, txBaseEBITDAMargin: 0.125,
  // GOES demand mode: "intensity" derives tons from revenue × ratio;
  // "units" uses explicit unit count × GOES/unit (mirrors greenfield approach)
  txDemandMode: "intensity",
  txGOESIntensity: 16,       // tons per $M revenue (range ~5-25; VTC ~10, Delta Star ~17)
  txExistUnits: 0,           // units/yr (detailed "units" mode only)
  txExistGOESPerUnit: 14,    // tons GOES per unit (detailed "units" mode only)
  txAcqMultiple: 8, txAcqNonCoreRevenue: 50, txAcqNonCoreMargin: 0.20,
  // TX Greenfield — capacity expansion
  txGreenfieldEnabled: true, txGfStartYear: 2,
  mpUnits: 150, goesPerMP: 14, mpASP: 1100000,
  mpOpCostPct: 0.56, mpIntermediatePct: 0.12,
  distUnits: 0, goesPerDist: 0.8, distASP: 22000,
  distOpCostPct: 0.61, distIntermediatePct: 0.08,
  ramp: [0, 0.30, 0.70, 1.0], gfRampYears: 4, greenfieldCapex: 150,
  internalizeIntermediate: false, internalizeFactor: 0.50, // in-house cost as fraction of outsourced (lower = more savings)
  // TX GOES Sourcing
  captivePct: 1.00,
  // Transformer Non-Core (removed — greenfield non-core no longer modeled)
  // Capital Structure
  entryMultiple: 8.0, workingCapital: 150, pensionLiability: 0, txnFees: 0.02,
  ltv: 0.60, costOfDebt: 0.07,
  // Returns
  exitMultiple: 10.5, holdPeriod: 10, waccRate: 0.082, waccMode: "manual",
  // Growth & Inflation
  cpiRate: 0.025, txPriceEscalation: 0.07, terminalGrowth: 0.025,
  // WACC Build-up
  riskFreeRate: 0.041, equityRiskPremium: 0.055, beta: 1.20, sizePremium: 0.02,
  // Working Capital
  nwcPctRevenue: 0.15, // NWC as % of revenue — delta flows through FCF each year
  // Debt Structure
  debtAmortYears: 7, // Amortizing term loan — 0 = interest-only bullet
  cashSweepPct: 0, // % of excess FCF applied to mandatory debt repayment
  // Sustaining Capex
  butlerMaintCapex: 40, txMaintCapex: 25,
  // Depreciation — step-up basis from acquisition
  acqDepreciablePct: 0.80, // % of acquisition price allocated to depreciable assets (PP&E + goodwill/intangibles; excludes land ~5%, NWC modeled separately)
  acqDepLife: 15, // Blended straight-line life (PP&E 10-20yr, goodwill/intangibles 15yr per §197)
  gfDepLife: 20, // Greenfield plant depreciation life
};

// ─── Scenario Overrides ─────────────────────────────────────────────────────
// Correlation-aware design: instead of a single "Bear" (every variable at its
// worst) or "Bull" (every variable at its best), we use THEMED scenarios that
// only stress variables within a correlated cluster. Variables outside the
// stressed cluster stay at base. This avoids compounding uncorrelated extremes,
// which is how IB/PE analysts actually build scenario models.
//
// Downside clusters:
//   weakMkt   — pricing & competitive pressure (macro/market correlated)
//   execRisk  — operational underperformance (execution correlated)
//   advFin    — adverse deal/financing terms (capital markets correlated)
//
// Upside clusters:
//   strongMkt — pricing tailwinds & delayed competition
//   opsExcel  — operational outperformance & cost efficiency
//   favDeal   — favorable entry/exit & financing
//
// Each themed scenario is individually plausible: the probability of ONE cluster
// going wrong/right is meaningful, unlike every variable simultaneously at extremes.

const OVERRIDES = {
  base: { label: "Base Case" },

  // ── Downside: Weak Market ──────────────────────────────────────────────────
  // Stress: GOES pricing, duopoly impact, Nippon timing, non-GOES revenue, TX margins
  // Unchanged: utilization ramp, production costs, deal structure, financing
  weakMkt: {
    label: "Weak Market",
    goesPrice: 5000, duopolyImpact: 0.22, nipponYear: 4,
    goesPriceInflation: 0.02, dodRenewal: false,
    nonGoesRevenue: 100, nonGoesMargin: 0.12,
    // TX existing — weaker margins, lower demand in soft market
    txBaseRevenue: 400, txBaseEBITDAMargin: 0.10, txGOESIntensity: 15,
    txAcqNonCoreRevenue: 35, txAcqNonCoreMargin: 0.15,
    // TX greenfield — lower ASPs, delayed start due to uncertain demand
    txGfStartYear: 3, gfRampYears: 5,
    mpASP: 700000, distASP: 18000, txPriceEscalation: 0.04,
    mpUnits: 100,
  },

  // ── Downside: Execution Risk ───────────────────────────────────────────────
  // Stress: slow ramp, high production costs, overhead, greenfield delays
  // Unchanged: market pricing, deal terms, financing
  execRisk: {
    label: "Execution Risk",
    goesStartUtil: 0.60, goesTargetUtil: 0.85, goesRampYears: 5,
    goesProductionCost: 3200, overheadPct: 0.09,
    butlerMaintCapex: 50,
    // TX existing — delayed integration, slower start
    txExistStartYear: 2,
    // TX greenfield — delayed, slow ramp, cost overruns
    txGfStartYear: 3, gfRampYears: 5,
    ramp: [0, 0.20, 0.50, 0.80], greenfieldCapex: 200,
    mpOpCostPct: 0.62, mpIntermediatePct: 0.14,
    distOpCostPct: 0.67, distIntermediatePct: 0.10,
    doeYear: 3,
    nwcPctRevenue: 0.18,
    cpiRate: 0.035,
  },

  // ── Downside: Adverse Financing ────────────────────────────────────────────
  // Stress: entry/exit multiples, cost of debt, leverage, pension, acquisition pricing
  // Unchanged: operations, market pricing
  advFin: {
    label: "Adverse Financing",
    entryMultiple: 9.0, exitMultiple: 9, workingCapital: 110,
    pensionLiability: 400,
    ltv: 0.45, costOfDebt: 0.08,
    // TX acquisition — overpay in competitive auction
    txAcqMultiple: 10,
    waccRate: 0.106, terminalGrowth: 0.02,
    riskFreeRate: 0.045, beta: 1.35, sizePremium: 0.025,
  },

  // ── Upside: Strong Market ──────────────────────────────────────────────────
  // Stress: GOES pricing up, competition delayed, DOE on, strong TX demand
  // Unchanged: utilization ramp, costs, deal structure
  strongMkt: {
    label: "Strong Market",
    goesPrice: 6500, duopolyImpact: 0.12, nipponYear: 7,
    goesPriceInflation: 0.05, doeOn: true, doeYear: 2,
    nonGoesRevenue: 150, nonGoesMargin: 0.18,
    // TX existing — strong backlog, higher margins from electrification boom
    txBaseRevenue: 600, txBaseEBITDAMargin: 0.15, txGOESIntensity: 17,
    txAcqNonCoreRevenue: 75, txAcqNonCoreMargin: 0.22,
    // TX greenfield — early start, strong ASPs, larger scale
    txGfStartYear: 1, gfRampYears: 3,
    mpASP: 1500000, distASP: 28000, txPriceEscalation: 0.10,
    mpUnits: 200,
  },

  // ── Upside: Operational Excellence ─────────────────────────────────────────
  // Stress: fast ramp, low costs, lean overhead, efficient greenfield
  // Unchanged: market pricing, deal terms
  opsExcel: {
    label: "Ops Excellence",
    goesStartUtil: 0.85, goesTargetUtil: 0.98, goesRampYears: 1,
    goesProductionCost: 2400, overheadPct: 0.05,
    butlerMaintCapex: 35,
    // TX greenfield — accelerated build, low costs, fast ramp
    txGfStartYear: 1, gfRampYears: 3,
    mpOpCostPct: 0.50, mpIntermediatePct: 0.10,
    distOpCostPct: 0.52, distIntermediatePct: 0.06,
    greenfieldCapex: 100, internalizeIntermediate: true,
    doeOn: true, doeYear: 1,
    nwcPctRevenue: 0.12,
    cpiRate: 0.020,
  },

  // ── Upside: Favorable Deal ─────────────────────────────────────────────────
  // Stress: cheap entry, rich exit, good leverage terms, bargain TX acquisition
  // Unchanged: operations, market pricing
  favDeal: {
    label: "Favorable Deal",
    entryMultiple: 7.0, exitMultiple: 16,
    ltv: 0.60, costOfDebt: 0.065,
    // TX acquisition — bargain price in distressed / off-market deal
    txAcqMultiple: 6,
    waccRate: 0.072, terminalGrowth: 0.03,
    riskFreeRate: 0.035, beta: 1.05, sizePremium: 0.015,
  },

  // ── Structural Scenarios ───────────────────────────────────────────────────
  goesOnly: {
    label: "GOES Only",
    txExistEnabled: false, txGreenfieldEnabled: false,
    mpUnits: 0, distUnits: 0, greenfieldCapex: 0, captivePct: 0,
    txMaintCapex: 0,
    workingCapital: 75, ltv: 0.50,
    exitMultiple: 10, waccRate: 0.09,
  },
  vtc: {
    label: "VTC Acquisition",
    goesStartUtil: 0.67, goesTargetUtil: 0.95, goesRampYears: 3, doeOn: true, doeYear: 2,
    txExistEnabled: true, txExistStartYear: 1, txGreenfieldEnabled: false,
    txBaseRevenue: 4000, txBaseEBITDAMargin: 0.25, txGOESIntensity: 10,
    txAcqMultiple: 3.5, txAcqNonCoreRevenue: 200, txAcqNonCoreMargin: 0.15,
    mpUnits: 0, distUnits: 0, greenfieldCapex: 0,
    workingCapital: 200, exitMultiple: 14, txMaintCapex: 60,
  },
  deltaStar: {
    label: "Delta Star",
    goesStartUtil: 0.65, goesTargetUtil: 0.88, goesRampYears: 3,
    txExistEnabled: true, txExistStartYear: 1, txGreenfieldEnabled: true, txGfStartYear: 2,
    txBaseRevenue: 300, txBaseEBITDAMargin: 0.22, txGOESIntensity: 17,
    txAcqMultiple: 7.5, txAcqNonCoreRevenue: 25, txAcqNonCoreMargin: 0.20,
    mpUnits: 150, gfRampYears: 4, greenfieldCapex: 175,
    exitMultiple: 13, txMaintCapex: 20,
  },
};

// Build DEFAULTS from BASE + OVERRIDES
export const DEFAULTS = {};
for (const [key, over] of Object.entries(OVERRIDES)) {
  DEFAULTS[key] = { ...BASE, ...over };
}

// Scenario grouping metadata — used by UI to organize the dropdown
export const SCENARIO_GROUPS = {
  downside: { label: "Downside Scenarios", keys: ["weakMkt", "execRisk", "advFin"] },
  central: { label: "Central", keys: ["base"] },
  upside: { label: "Upside Scenarios", keys: ["strongMkt", "opsExcel", "favDeal"] },
  structural: { label: "Structural", keys: ["goesOnly", "vtc", "deltaStar"] },
};

export const SCENARIO_KEYS = [
  "weakMkt", "execRisk", "advFin",
  "base",
  "strongMkt", "opsExcel", "favDeal",
  "goesOnly", "vtc", "deltaStar",
];
export const SCENARIO_LABELS = {
  weakMkt: "Weak Market", execRisk: "Execution Risk", advFin: "Adverse Financing",
  base: "Base Case",
  strongMkt: "Strong Market", opsExcel: "Ops Excellence", favDeal: "Favorable Deal",
  goesOnly: "GOES Only", vtc: "VTC Acquisition", deltaStar: "Delta Star",
};

// ─── Scenario Loading ───────────────────────────────────────────────────────
// Themed scenarios load at their exact override values (no blending needed).
// Each scenario only overrides its correlated cluster; all other variables
// inherit from BASE. This replaces the old bear/bull 50% blending approach —
// the correlation-aware design makes blending unnecessary because each scenario
// is already individually plausible.
export function blendScenario(scenarioKey) {
  const full = DEFAULTS[scenarioKey];
  if (!full) return null;
  return { ...full };
}

// ─── Slider Reference Markers (downside/base/upside extremes) ───────────────
// These show the full range each variable can take across themed scenarios.
// "down" = worst themed value, "up" = best themed value. The markers help users
// see where each slider sits relative to scenario boundaries.
export const MARKERS = {
  overheadPct: { bear: 0.09, base: 0.07, bull: 0.05 },
  // NOTE: goesStartUtil color mapping should be INVERTED in the UI (red=high, green=low)
  // because lower starting utilization means cheaper entry price → better IRR.
  goesStartUtil: { bear: 0.60, base: 0.70, bull: 0.85 },
  goesTargetUtil: { bear: 0.85, base: 0.92, bull: 0.98 },
  goesRampYears: { bear: 5, base: 2, bull: 1 },
  goesPrice: { bear: 5000, base: 5600, bull: 6500 },
  duopolyImpact: { bear: 0.22, base: 0.17, bull: 0.12 },
  goesProductionCost: { bear: 3200, base: 2800, bull: 2400 },
  nipponYear: { bear: 4, base: 5, bull: 7 },
  doeYear: { bear: 3, base: 1, bull: 2 },
  nonGoesRevenue: { bear: 100, base: 120, bull: 150 },
  nonGoesMargin: { bear: 0.12, base: 0.15, bull: 0.18 },
  mpUnits: { bear: 150, base: 300, bull: 450 },
  goesPerMP: { bear: 16, base: 14, bull: 12 },
  mpASP: { bear: 700000, base: 1100000, bull: 1500000 },
  mpOpCostPct: { bear: 0.62, base: 0.56, bull: 0.50 },
  distUnits: { bear: 0, base: 0, bull: 2000 },
  distASP: { bear: 18000, base: 22000, bull: 28000 },
  distOpCostPct: { bear: 0.67, base: 0.61, bull: 0.52 },
  captivePct: { bear: 0.50, base: 1.00, bull: 1.00 },
  entryMultiple: { bear: 9, base: 8, bull: 7 },
  greenfieldCapex: { bear: 200, base: 150, bull: 100 },
  ltv: { bear: 0.45, base: 0.60, bull: 0.60 },
  costOfDebt: { bear: 0.08, base: 0.07, bull: 0.065 },
  exitMultiple: { bear: 9, base: 10.5, bull: 16 },
  holdPeriod: { bear: 12, base: 10, bull: 7 },
  butlerMaintCapex: { bear: 50, base: 40, bull: 35 },
  txMaintCapex: { bear: 35, base: 25, bull: 15 },
  pensionLiability: { bear: 400, base: 0, bull: 0 },
  goesPriceInflation: { bear: 0.02, base: 0.035, bull: 0.05 },
  cpiRate: { bear: 0.035, base: 0.025, bull: 0.020 },
  txPriceEscalation: { bear: 0.04, base: 0.07, bull: 0.10 },
  txExistStartYear: { bear: 2, base: 1, bull: 1 },
  txGfStartYear: { bear: 3, base: 2, bull: 1 },
  txBaseRevenue: { bear: 400, base: 500, bull: 600 },
  txBaseEBITDAMargin: { bear: 0.10, base: 0.125, bull: 0.15 },
  txGOESIntensity: { bear: 15, base: 16, bull: 17 },
  txAcqMultiple: { bear: 10, base: 8, bull: 6 },
  txAcqNonCoreRevenue: { bear: 35, base: 50, bull: 75 },
  txAcqNonCoreMargin: { bear: 0.15, base: 0.20, bull: 0.22 },
  gfRampYears: { bear: 5, base: 4, bull: 3 },
  terminalGrowth: { bear: 0.02, base: 0.025, bull: 0.03 },
  riskFreeRate: { bear: 0.045, base: 0.041, bull: 0.035 },
  beta: { bear: 1.35, base: 1.20, bull: 1.05 },
  sizePremium: { bear: 0.025, base: 0.02, bull: 0.015 },
  nwcPctRevenue: { bear: 0.18, base: 0.15, bull: 0.12 },
  waccRate: { bear: 0.12, base: 0.09, bull: 0.08 },
};

// ─── Core Model ─────────────────────────────────────────────────────────────
/**
 * Run the full 10-year GOES-to-Transformer financial model.
 *
 * @param {Object} inputs - Model parameters (merged with BASE defaults).
 *   Key groups: Steel Mill (goesStartUtil, goesPrice, goesProductionCost, ...),
 *   Transformer Existing (txBaseRevenue, txBaseEBITDAMargin, ...), Transformer Greenfield (mpUnits,
 *   mpASP, ...), Capital Structure (entryMultiple, ltv, ...), Growth/Inflation
 *   (cpiRate, txPriceEscalation, ...), Returns (exitMultiple, holdPeriod, waccRate).
 *   See BASE object above for all ~60 parameters and their defaults.
 *
 * @returns {Object} Full model output:
 *   - years[]: Array of year-by-year projections (production, revenue, EBITDA, FCF, debt, etc.)
 *   - wacc, ke, kdAfterTax: Discount rate and components
 *   - totalInvestment, debtInitial, equity, debtAtExit: Capital structure
 *   - pvFCFs[], sumPVFCFs: Present values of interim free cash flows
 *   - tvExitMult, pvTVExit, evExit, eqValExit, impliedMultiple: Exit Multiple DCF
 *   - tvGordon, pvTVGordon, evGordon, eqValGordon: Gordon Growth DCF
 *   - terminalEBITDA, terminalUFCF: Terminal year metrics
 *   - uIRR, lIRR, realUIRR, realLIRR: Nominal and real IRRs
 *   - equityMultiple: Equity MOIC (total distributions / equity)
 *   - paybackPeriod: Years to recover total investment (null if >hold)
 *   - stab: Stabilized-year snapshot (last year metrics)
 *   - butlerAcqPrice, txAcqPrice: Acquisition prices ($M)
 *   - warnings[]: Array of warning strings for edge cases
 *   - Backward compat aliases: ti, debt, eq, eqM, pb, tE, ev, eqVal, pvTV, implM, etc.
 */
export function runModel(inputs) {
  const p = { ...BASE, ...inputs };
  const {
    goesProductionCost,
    nipponYear, dodOn, dodRenewal, doeOn, doeYear,
    goesPriceInflation, overheadPct,
    nonGoesRevenue, nonGoesMargin,
    txExistEnabled, txExistStartYear, txBaseRevenue, txBaseEBITDAMargin,
    txDemandMode, txGOESIntensity, txExistUnits, txExistGOESPerUnit,
    txAcqMultiple, txAcqNonCoreRevenue, txAcqNonCoreMargin,
    txGreenfieldEnabled, txGfStartYear,
    mpUnits, goesPerMP, mpASP,
    mpOpCostPct, mpIntermediatePct,
    distUnits, goesPerDist, distASP,
    distOpCostPct, distIntermediatePct,
    ramp, gfRampYears, greenfieldCapex, internalizeIntermediate,
    captivePct,
    entryMultiple, workingCapital, pensionLiability, txnFees,
    ltv, costOfDebt,
    exitMultiple, holdPeriod, waccMode, waccRate,
    cpiRate, txPriceEscalation, terminalGrowth,
    riskFreeRate, equityRiskPremium, beta, sizePremium,
    nwcPctRevenue, debtAmortYears, cashSweepPct, butlerMaintCapex, txMaintCapex,
    acqDepreciablePct, acqDepLife, gfDepLife,
  } = p;

  const goesStartUtil = p.goesStartUtil ?? BASE.goesStartUtil;
  const goesTargetUtil = p.goesTargetUtil ?? goesStartUtil;
  const goesRampYears = p.goesRampYears ?? BASE.goesRampYears;

  const goesPrice = p.goesPrice ?? BASE.goesPrice;
  const duopolyImpact = p.duopolyImpact ?? BASE.duopolyImpact;
  const goesPostDuopolyPrice = goesPrice * (1 - duopolyImpact);

  // Operating cost with internalize savings
  const intFactor = p.internalizeFactor ?? INTERNALIZE_FACTOR_DEFAULT;
  const mpIntermSavings = internalizeIntermediate ? mpIntermediatePct * (1 - intFactor) : 0;
  const distIntermSavings = internalizeIntermediate ? distIntermediatePct * (1 - intFactor) : 0;
  const mpEffOpCostPct = mpOpCostPct - mpIntermSavings;
  const distEffOpCostPct = distOpCostPct - distIntermSavings;

  // Effective TX segment enables
  const txExistActive = txExistEnabled !== false && txBaseRevenue > 0;
  const txGfActive = txGreenfieldEnabled !== false;

  // Derive effective GOES demand for existing TX business
  // "intensity" mode: demand = revenue × intensity ratio (tons per $M)
  // "units" mode: demand = units/yr × GOES tons per unit (mirrors greenfield)
  const txBaseGOESDemand = txDemandMode === "units"
    ? txExistUnits * txExistGOESPerUnit
    : txBaseRevenue * txGOESIntensity;

  // Compute TX acquisition price from EBITDA multiple
  const txAcqPrice = txExistActive ? Math.round(txAcqMultiple * txBaseRevenue * txBaseEBITDAMargin) : 0;

  // Compute linear ramp from gfRampYears, relative to greenfield start year
  const computeRamp = (y) => {
    const yRel = y - (txGfStartYear || 1) + 1; // years since greenfield start
    if (yRel < 1) return 0;
    // If explicit ramp array exists and has entries, use it for backwards compat
    if (ramp && ramp.length > 0 && yRel <= ramp.length) return ramp[Math.min(yRel - 1, ramp.length - 1)];
    // Otherwise use linear ramp over gfRampYears
    if (!gfRampYears || gfRampYears <= 0) return 1;
    return Math.min(1, (yRel - 1) / gfRampYears);
  };

  // ── WACC ──
  let wacc, ke, kdAfterTax;
  if (waccMode === "manual") {
    wacc = waccRate;
    ke = null;
    kdAfterTax = null;
  } else {
    ke = riskFreeRate + beta * equityRiskPremium + sizePremium;
    kdAfterTax = costOfDebt * (1 - TAX_RATE);
    wacc = (1 - ltv) * ke + ltv * kdAfterTax;
  }

  // ── Y1 normalized Steel Mill EBITDA (for entry valuation) ──
  // Standalone means no captive — all production sold externally.
  // Entry valuation uses current (pre-duopoly) market price, since the seller
  // prices the business on today's EBITDA. Duopoly risk is a future headwind
  // that reduces IRR — if the buyer wants to discount for it at entry, they
  // adjust the entry multiple. This ensures higher duopolyImpact → lower IRR.
  // Y1 EBITDA uses starting utilization (current operations) for entry valuation
  const y1DoeBlend = doeOn ? Math.min(1, Math.max(0, (1 - doeYear + 1) / DOE_RAMP_YEARS)) : 0;
  const y1Prod = NAMEPLATE * goesStartUtil;
  const y1PC = goesProductionCost - (DOE_SAVINGS_PER_TON * y1DoeBlend);
  const y1MP = goesPrice; // Entry valuation at current market price
  const y1DodT = dodOn ? DOD_TONS : 0;
  const y1TPT = Math.max(0, y1Prod - y1DodT);
  const y1GoesRev = (y1TPT * y1MP + y1DodT * DOD_PRICE) / 1e6;
  const y1GoesCOGS = (y1Prod * y1PC) / 1e6;
  const y1GoesGP = y1GoesRev - y1GoesCOGS;
  const y1NonGoesGP = nonGoesRevenue * nonGoesMargin;
  const y1SegRev = y1GoesRev + nonGoesRevenue;
  const y1ButlerEBITDA = y1GoesGP + y1NonGoesGP - (y1SegRev * overheadPct);

  // ── Sources & Uses ── (Transformer acq/capex zeroed if segment disabled)
  const butlerAcqPrice = Math.round(entryMultiple * Math.max(y1ButlerEBITDA, 50));
  const effTxAcqPrice = txExistActive ? txAcqPrice : 0;
  const effGfCapex = txGfActive ? greenfieldCapex : 0;
  const txnFeesAmt = (butlerAcqPrice + effTxAcqPrice) * txnFees;
  const totalUses = butlerAcqPrice + effTxAcqPrice + effGfCapex + workingCapital + pensionLiability + txnFeesAmt;
  const doeGrantAmt = doeOn ? DOE_GRANT_AMOUNT : 0;
  const ti = totalUses - doeGrantAmt;
  const debtInitial = ti * ltv;
  const eq = ti - debtInitial;
  // Scheduled annual amortization (0 if interest-only)
  const schedAmort = debtAmortYears > 0 ? debtInitial / debtAmortYears : 0;

  // ── Input Validation ──
  const warnings = [];
  if (goesTargetUtil <= 0) warnings.push("Target utilization is 0% — no GOES production.");
  if (entryMultiple < 3) warnings.push(`Entry multiple (${entryMultiple.toFixed(1)}x) is unusually low for specialty metals.`);
  if (entryMultiple > 20) warnings.push(`Entry multiple (${entryMultiple.toFixed(1)}x) is unusually high — verify assumption.`);
  {
    const maxUtil = doeOn ? (NAMEPLATE + DOE_CAPACITY) / NAMEPLATE : 1.0;
    if (goesTargetUtil > maxUtil) warnings.push(`Target utilization (${(goesTargetUtil * 100).toFixed(0)}%) exceeds max capacity (${(maxUtil * 100).toFixed(0)}%).`);
  }
  {
    const prod = NAMEPLATE * goesTargetUtil;
    const dodT = dodOn ? DOD_TONS : 0;
    const spare = Math.max(0, prod - dodT);
    const txDemand = (txGfActive ? mpUnits * goesPerMP + distUnits * goesPerDist : 0) + (txExistActive ? txBaseGOESDemand : 0);
    const captiveDemand = txDemand * captivePct;
    if (captiveDemand > spare * 1.05) warnings.push(`Captive GOES demand (${fmt(Math.round(captiveDemand))}t) exceeds spare capacity (${fmt(Math.round(spare))}t) — will be capped.`);
  }
  // GOES intensity sanity check
  if (txExistActive && txDemandMode === "intensity") {
    if (txGOESIntensity < 3) warnings.push(`GOES intensity (${txGOESIntensity} t/$M) is unusually low — implies minimal GOES usage relative to revenue.`);
    if (txGOESIntensity > 30) warnings.push(`GOES intensity (${txGOESIntensity} t/$M) is unusually high — verify assumption.`);
  }
  if (exitMultiple < entryMultiple * 0.5) warnings.push("Exit multiple is less than half the entry multiple — likely negative returns.");
  if (exitMultiple > entryMultiple * 1.5) warnings.push(`Exit multiple (${exitMultiple.toFixed(1)}x) is >1.5× entry (${entryMultiple.toFixed(1)}x) — optimistic assumption.`);
  if (wacc <= terminalGrowth) warnings.push("WACC ≤ terminal growth — Gordon Growth terminal value is undefined.");
  if (eq <= 0) warnings.push("Equity ≤ 0 — equity multiple is meaningless.");
  if (txGfActive && greenfieldCapex > 0 && mpUnits === 0 && distUnits === 0) warnings.push("Greenfield capex allocated but no transformer units specified.");
  if (txPriceEscalation > cpiRate * 3) warnings.push(`Transformer price escalation (${fmtPct(txPriceEscalation)}) significantly exceeds CPI (${fmtPct(cpiRate)}) — verify long-term sustainability.`);

  // ── Year-by-year projections ──
  const years = [];
  let cumUFCF = 0;
  let prevNWC = workingCapital; // Initialize to closing NWC so Y1 deltaNWC only captures incremental change
  let debtBal = debtInitial; // Remaining debt balance (decreases with amort + sweep)

  for (let y = 0; y <= holdPeriod; y++) {
    if (y === 0) {
      years.push(zeroYear());
      continue;
    }

    // Ramp — uses linear ramp over gfRampYears (with fallback to explicit ramp array)
    const rp = computeRamp(y);

    // Escalation factors: Y1=base, Y2=base*(1+r), etc.
    const cpiEsc = Math.pow(1 + cpiRate, y - 1);
    const txPriceEsc = Math.pow(1 + txPriceEscalation, y - 1);
    const nonGoesEsc = cpiEsc; // Non-GOES revenue tracks CPI automatically

    // DOE — linear ramp over DOE_RAMP_YEARS starting at doeYear
    const doeBlend = doeOn ? Math.min(1, Math.max(0, (y - doeYear + 1) / DOE_RAMP_YEARS)) : 0;
    const doeActive = doeBlend > 0;

    // Duopoly — gradual 4-year transition as Nippon ramps production
    // Y<nipponYear: pre-duopoly price. Y=nipponYear: 25% post. Fully post at nipponYear+3.
    const duoBlend = Math.min(1, Math.max(0, (y - nipponYear + 1) / DUOPOLY_TRANSITION_YEARS));
    const duo = duoBlend > 0;
    const priceEsc = Math.pow(1 + goesPriceInflation, y - 1);
    const mktPrice = (goesPrice * (1 - duoBlend) + goesPostDuopolyPrice * duoBlend) * priceEsc;

    // GOES production — utilization ramps from start → target over rampYears.
    // With DOE active, capacity ramps linearly (max ~114% at full DOE).
    const utilBlend = goesRampYears > 0 ? Math.min(1, (y - 1) / goesRampYears) : 1;
    const utilY = goesStartUtil + (goesTargetUtil - goesStartUtil) * utilBlend;
    const cap = NAMEPLATE + (DOE_CAPACITY * doeBlend);
    const production = Math.min(NAMEPLATE * utilY, cap);
    // Fixed cost absorption: fixed portion of production cost spreads over more
    // tons at higher utilization, reducing effective $/ton. At goesStartUtil the
    // effective cost equals goesProductionCost exactly (no adjustment).
    const fixedPerTon = goesProductionCost * FIXED_COST_SHARE * goesStartUtil / utilY;
    const variablePerTon = goesProductionCost * (1 - FIXED_COST_SHARE);
    const prodCost = (fixedPerTon + variablePerTon - DOE_SAVINGS_PER_TON * doeBlend) * cpiEsc;

    // DOD
    const dodActive = dodOn && (y <= 5 || dodRenewal);
    const dodTons = dodActive ? DOD_TONS : 0;

    // Transformer GOES demand (respects enable toggles + start years)
    const gfStarted = txGfActive && y >= txGfStartYear;
    const existStarted = txExistActive && y >= txExistStartYear;
    const mpUnitsY = gfStarted ? mpUnits * rp : 0;
    const distUnitsY = gfStarted ? distUnits * rp : 0;
    const gfGOESDemand = mpUnitsY * goesPerMP + distUnitsY * goesPerDist;
    const existGOESDemand = existStarted ? txBaseGOESDemand : 0;
    const totalTXGOESDemand = gfGOESDemand + existGOESDemand;

    // Captive allocation with constraint
    const spare = Math.max(0, production - dodTons);
    const desiredCaptive = totalTXGOESDemand * captivePct;
    const actualCaptive = Math.min(desiredCaptive, spare);
    const marketPurchase = totalTXGOESDemand - actualCaptive;
    const captiveCapped = desiredCaptive > spare;

    // GOES segment
    const thirdPartyTons = Math.max(0, production - dodTons - actualCaptive);
    const dodRevenue = (dodTons * DOD_PRICE) / 1e6;
    const thirdPartyRevenue = (thirdPartyTons * mktPrice) / 1e6;
    const goesExtRev = dodRevenue + thirdPartyRevenue;
    const goesCOGS = (production * prodCost) / 1e6;
    const goesGP = goesExtRev - goesCOGS;

    // Non-GOES
    const nonGoesRevY = nonGoesRevenue * nonGoesEsc;
    const nonGoesGP = nonGoesRevY * nonGoesMargin;

    // GOES segment EBITDA — overhead as % of Steel Mill segment revenue
    const overheadY = (goesExtRev + nonGoesRevY) * overheadPct;
    const goesEBITDA = goesGP + nonGoesGP - overheadY;
    const goesSegRev = goesExtRev + nonGoesRevY;
    const goesMargin = goesSegRev > 0 ? goesEBITDA / goesSegRev : 0;

    // ── Transformer Existing Business ── (zeroed if disabled or before start year)
    const txExistRevY = existStarted ? txBaseRevenue * txPriceEsc : 0;
    const txExistEBITDA_pre = txExistRevY * txBaseEBITDAMargin;
    // Captive advantage: proportional allocation
    const existFrac = totalTXGOESDemand > 0 ? existGOESDemand / totalTXGOESDemand : 0;
    const existCaptive = actualCaptive * existFrac;
    const captiveAdvExist = existCaptive * (mktPrice - prodCost) / 1e6;
    const adjExistEBITDA = txExistEBITDA_pre + captiveAdvExist;
    // Existing non-core
    const txAcqNCRevY = existStarted ? txAcqNonCoreRevenue * txPriceEsc : 0;
    const txAcqNCEBITDA = txAcqNCRevY * txAcqNonCoreMargin;

    // ── Transformer Greenfield ── (zeroed if disabled)
    const mpRevY = (mpUnitsY * mpASP * txPriceEsc) / 1e6;
    const distRevY = (distUnitsY * distASP * txPriceEsc) / 1e6;
    // GOES cost for greenfield
    const gfFrac = totalTXGOESDemand > 0 ? gfGOESDemand / totalTXGOESDemand : 0;
    const gfCaptive = actualCaptive * gfFrac;
    const gfMarketPurchase = marketPurchase * gfFrac;
    const gfGOESCostCap = (gfCaptive * prodCost) / 1e6;
    const gfGOESCostMkt = (gfMarketPurchase * mktPrice) / 1e6;
    const gfGOESCost = gfGOESCostCap + gfGOESCostMkt;
    // Operating costs — single % per product (includes interm savings if applicable)
    const mpOpCostY = (mpUnitsY * mpASP * mpEffOpCostPct * cpiEsc) / 1e6;
    const distOpCostY = (distUnitsY * distASP * distEffOpCostPct * cpiEsc) / 1e6;
    const gfOpCost = mpOpCostY + distOpCostY;
    const gfRev = mpRevY + distRevY;
    const gfEBITDA = gfRev - gfGOESCost - gfOpCost;
    const gfMargin = gfRev > 0 ? gfEBITDA / gfRev : 0;
    // Greenfield captive advantage (display)
    const captiveAdvGF = gfCaptive * (mktPrice - prodCost) / 1e6;

    // ── Transformer Non-Core (Greenfield) — removed from model ──
    const txNCRevY = 0;
    const txNCEBITDA = 0;

    // ── Transformer Segment Totals ──
    const txTotalRev = txExistRevY + txAcqNCRevY + gfRev + txNCRevY;
    const txTotalEBITDA = adjExistEBITDA + txAcqNCEBITDA + gfEBITDA + txNCEBITDA;
    const txMargin = txTotalRev > 0 ? txTotalEBITDA / txTotalRev : 0;
    const totalCaptiveAdv = captiveAdvExist + captiveAdvGF;

    // ── Consolidated ──
    const totalRev = goesSegRev + txTotalRev;
    const totalEBITDA = goesEBITDA + txTotalEBITDA;
    const margin = totalRev > 0 ? totalEBITDA / totalRev : 0;

    // Working capital — NWC as % of revenue, delta reduces FCF
    const nwc = totalRev * nwcPctRevenue;
    const deltaNWC = nwc - prevNWC;
    prevNWC = nwc;

    // Capex, D&A, taxes, FCF
    const mc = (butlerMaintCapex + txMaintCapex) * cpiEsc;
    // D&A: step-up depreciation on acquisition basis + greenfield capex + maintenance
    const acqDA = (butlerAcqPrice + effTxAcqPrice) * acqDepreciablePct / acqDepLife;
    const gfDA = effGfCapex > 0 && gfDepLife > 0 ? effGfCapex / gfDepLife : 0;
    const maintDA = mc * 0.5;
    const da = acqDA + gfDA + maintDA;
    const intAnn = debtBal * costOfDebt;
    const ebit = totalEBITDA - da;
    // Unlevered tax (no interest deduction) — used for UFCF and DCF
    const tax = Math.max(0, ebit * TAX_RATE);
    const ufcf = totalEBITDA - mc - tax - deltaNWC;
    // Levered tax (after interest deduction) — used for LFCF
    const ebt = ebit - intAnn;
    const taxLevered = Math.max(0, ebt * TAX_RATE);
    // Debt service: scheduled amortization + cash sweep
    const amort = Math.min(schedAmort, debtBal);
    const preSweepFCF = totalEBITDA - mc - taxLevered - intAnn - deltaNWC - amort;
    const sweep = cashSweepPct > 0 ? Math.min(Math.max(0, preSweepFCF) * cashSweepPct, debtBal - amort) : 0;
    const totalPrincipal = amort + sweep;
    debtBal = Math.max(0, debtBal - totalPrincipal);
    const lfcf = totalEBITDA - mc - taxLevered - intAnn - totalPrincipal - deltaNWC;
    cumUFCF += ufcf;

    years.push({
      year: y, rp, duo, duoBlend, doeActive, doeBlend, dodActive, captiveCapped, utilY,
      // GOES segment
      cap, production, prodCost, mktPrice, dodTons,
      thirdPartyTons, actualCaptive, dodRevenue, thirdPartyRevenue, goesExtRev, nonGoesRevY,
      goesCOGS, goesGP, overheadY, nonGoesGP, goesEBITDA, goesSegRev, goesMargin,
      // TX existing
      txExistRevY, txExistEBITDA_pre, existCaptive, captiveAdvExist, adjExistEBITDA,
      txAcqNCRevY, txAcqNCEBITDA,
      // TX greenfield
      mpUnitsY, distUnitsY, mpRevY, distRevY, gfRev,
      gfGOESCost, gfGOESCostCap, gfGOESCostMkt,
      gfOpCost,
      gfEBITDA, gfMargin, gfCaptive, gfMarketPurchase, captiveAdvGF,
      // TX non-core
      txNCRevY, txNCEBITDA,
      // TX totals
      txTotalRev, txTotalEBITDA, txMargin, totalCaptiveAdv,
      // Consolidated
      totalRev, totalEBITDA, margin,
      nwc, deltaNWC, mc, da, acqDA, gfDA, maintDA, ebit, ebt, tax, taxLevered, ufcf, lfcf, intAnn,
      debtBal, amort, sweep, totalPrincipal, cumUFCF: cumUFCF,
      // Sourcing
      totalTXGOESDemand, desiredCaptive, marketPurchase, spare,
    });
  }

  // ── Terminal value & returns ──
  const termYear = years[holdPeriod];
  const tE = termYear.totalEBITDA;
  const tv = tE * exitMultiple;

  // Remaining debt at exit (after amortization + sweeps over hold period)
  const debtAtExit = termYear.debtBal;

  // IRR (nominal)
  const uCFs = years.map((yr, i) => i === 0 ? -ti : i === holdPeriod ? yr.ufcf + tv : yr.ufcf);
  const lCFs = years.map((yr, i) => i === 0 ? -eq : i === holdPeriod ? yr.lfcf + tv - debtAtExit : yr.lfcf);
  const uIRR = calculateIRR(uCFs);
  const lIRR = calculateIRR(lCFs);

  // IRR (real)
  const realUIRR = uIRR != null ? (1 + uIRR) / (1 + cpiRate) - 1 : null;
  const realLIRR = lIRR != null ? (1 + lIRR) / (1 + cpiRate) - 1 : null;

  // Equity multiple (MOIC)
  const tDist = years.reduce((s, yr) => s + yr.lfcf, 0) + tv - debtAtExit;
  const equityMultiple = eq > 0 ? tDist / eq : 0;

  // Payback period
  let cum = -ti, pb = null;
  for (let i = 1; i <= holdPeriod; i++) {
    cum += years[i].ufcf;
    if (cum >= 0 && pb === null) {
      const prev = cum - years[i].ufcf;
      pb = i - 1 + (-prev) / years[i].ufcf;
    }
  }

  // Stabilized year (first full ramp, typically Y4)
  const stab = years[Math.min(4, holdPeriod)] || years[years.length - 1];

  // ── DCF Valuation ──
  // Present Value of Interim Free Cash Flows
  const pvFCFs = years.filter(yr => yr.year > 0).map((yr, i) => yr.ufcf / Math.pow(1 + wacc, i + 1));
  const sumPVFCFs = pvFCFs.reduce((s, v) => s + v, 0);

  // Method A: Exit Multiple
  const tvExitMult = tE * exitMultiple;
  const pvTVExit = tvExitMult / Math.pow(1 + wacc, holdPeriod);
  const evExit = sumPVFCFs + pvTVExit;

  // Method B: Gordon Growth
  const terminalUFCF = termYear.ufcf;
  const tvGordon = (wacc > terminalGrowth && terminalUFCF > 0)
    ? (terminalUFCF * (1 + terminalGrowth)) / (wacc - terminalGrowth) : 0;
  const pvTVGordon = tvGordon / Math.pow(1 + wacc, holdPeriod);
  const evGordon = sumPVFCFs + pvTVGordon;

  // Enterprise & Equity Values
  const eqValExit = evExit - debtInitial;
  const eqValGordon = evGordon - debtAtExit;
  const impliedMultiple = tE > 0 ? evExit / tE : 0;

  // Backward compat aliases
  const ev = evExit;
  const pvTV = pvTVExit;
  const eqVal = eqValExit;
  const implM = impliedMultiple;

  // ── Chart data ──
  const chart = years.filter(yr => yr.year > 0).map((yr) => ({
    name: `Y${yr.year}`,
    goesEBITDA: Math.round(yr.goesEBITDA),
    existTXEBITDA: Math.round(yr.adjExistEBITDA + yr.txAcqNCEBITDA),
    greenfieldEBITDA: Math.round(yr.gfEBITDA),
    nonCoreEBITDA: Math.round(yr.txNCEBITDA),
    ufcf: Math.round(yr.ufcf),
    lfcf: Math.round(yr.lfcf),
    cumUFCF: Math.round(yr.cumUFCF),
    duo: yr.duo,
  }));

  return {
    // ── Spec-named outputs (Section 9) ──
    years, wacc, ke, kdAfterTax,
    totalInvestment: ti, debtInitial, equity: eq, debtAtExit,
    pvFCFs, sumPVFCFs,
    tvExitMult, pvTVExit, evExit, eqValExit, impliedMultiple,
    tvGordon, pvTVGordon, evGordon, eqValGordon,
    terminalEBITDA: tE, terminalUFCF,
    uIRR, lIRR, realUIRR, realLIRR,
    equityMultiple, paybackPeriod: pb,

    // ── Additional model outputs ──
    stab, butlerAcqPrice, txAcqPrice: effTxAcqPrice,
    totalUses, doeGrantAmt, txnFeesAmt,
    y1ButlerEBITDA, tv, chart, warnings,
    greenfieldCapex: effGfCapex, workingCapital, pensionLiability,
    goesStartUtil, goesTargetUtil, goesRampYears,
    goesPrice, duopolyImpact, goesPostDuopolyPrice,
    txBaseGOESDemand,

    // ── Backward compat aliases (used by existing UI components) ──
    ti, debt: debtInitial, eq, eqM: equityMultiple, pb, tE, termUFCF: terminalUFCF,
    ev, eqVal, pvTV, implM, intAnn: debtInitial * costOfDebt,
    acqPrice: butlerAcqPrice, waccRate: wacc, tvDCF: tvGordon,
  };
}

// ── Helper: zero year entry ──
function zeroYear() {
  const z = { year: 0, rp: 0, duo: false, doeActive: false, doeBlend: 0, dodActive: false, captiveCapped: false, utilY: 0 };
  const numKeys = [
    "cap", "production", "prodCost", "mktPrice", "dodTons",
    "thirdPartyTons", "actualCaptive", "dodRevenue", "thirdPartyRevenue", "goesExtRev", "nonGoesRevY",
    "goesCOGS", "goesGP", "overheadY", "nonGoesGP", "goesEBITDA", "goesSegRev", "goesMargin",
    "txExistRevY", "txExistEBITDA_pre", "existCaptive", "captiveAdvExist", "adjExistEBITDA",
    "txAcqNCRevY", "txAcqNCEBITDA",
    "mpUnitsY", "distUnitsY", "mpRevY", "distRevY", "gfRev",
    "gfGOESCost", "gfGOESCostCap", "gfGOESCostMkt",
    "gfOpCost",
    "gfEBITDA", "gfMargin", "gfCaptive", "gfMarketPurchase", "captiveAdvGF",
    "txNCRevY", "txNCEBITDA",
    "txTotalRev", "txTotalEBITDA", "txMargin", "totalCaptiveAdv",
    "totalRev", "totalEBITDA", "margin",
    "nwc", "deltaNWC", "mc", "da", "acqDA", "gfDA", "maintDA", "ebit", "ebt", "tax", "taxLevered", "ufcf", "lfcf", "intAnn",
    "debtBal", "amort", "sweep", "totalPrincipal", "cumUFCF",
    "totalTXGOESDemand", "desiredCaptive", "marketPurchase", "spare",
  ];
  for (const k of numKeys) z[k] = 0;
  return z;
}

// ─── Utility: strip label/custom metadata ───────────────────────────────────
export function strip(obj) {
  if (!obj) return {};
  const { label: _L, custom: _C, ...rest } = obj;
  return rest;
}
