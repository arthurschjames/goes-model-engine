// ─── Model Engine v2 ───────────────────────────────────────────────────────
// Pure financial model logic — no React, no UI.
// Implements GOES-to-Transformer financial model per SPEC_v2 + Addendum v2.

// ─── IRR Solver ─────────────────────────────────────────────────────────────
// Multi-strategy solver: Newton-Raphson with multiple initial guesses, then
// bisection fallback. Handles cashflow series with multiple sign changes
// (e.g., deferred capex creating mid-hold outflows) where a single Newton
// guess may find the wrong root or diverge.

/**
 * Net present value of a cashflow series at a given discount rate.
 * CF[0] is the period-0 (immediate) flow; CF[t] is discounted by (1+rate)^t.
 * @param {number[]} cashflows - Array of periodic cashflows
 * @param {number}   rate      - Periodic discount rate (decimal, e.g. 0.15 = 15%)
 * @returns {number} NPV
 */
function _npv(cashflows, rate) {
  let npv = 0;
  for (let t = 0; t < cashflows.length; t++) npv += cashflows[t] / Math.pow(1 + rate, t);
  return npv;
}

/**
 * Newton-Raphson IRR solver.
 * Iterates: rate_new = rate - NPV(rate) / NPV'(rate)
 * where NPV'(rate) = -Σ [ t * CF[t] / (1+rate)^(t+1) ] (first derivative w.r.t. rate).
 * Terminates when |NPV| < $0.01 (i.e. negligibly close to zero).
 * Guards against: zero derivative (flat NPV curve), rate divergence outside [-95%, 500%].
 * @param {number[]} cashflows - Cashflow series
 * @param {number}   guess     - Initial rate guess
 * @returns {number|null} IRR as decimal, or null if diverged/failed
 */
function _newtonRaphsonIRR(cashflows, guess) {
  let rate = guess;
  for (let i = 0; i < 2000; i++) {
    let npv = 0, dnpv = 0;
    for (let t = 0; t < cashflows.length; t++) {
      const d = Math.pow(1 + rate, t);
      npv += cashflows[t] / d;
      dnpv -= t * cashflows[t] / (d * (1 + rate)); // derivative: -t*CF/(1+r)^(t+1)
    }
    if (Math.abs(npv) < 0.01) return rate; // converged — NPV < $0.01M
    if (Math.abs(dnpv) < 1e-12) return null; // flat derivative — can't continue
    const next = rate - npv / dnpv;
    if (next < -0.95 || next > 5 || isNaN(next)) return null; // diverged
    rate = next;
  }
  return null; // max iterations exceeded without convergence
}

/**
 * Bisection IRR solver — guaranteed to find a root when one exists in [lo, hi].
 * Requires NPV(lo) and NPV(hi) to have opposite signs (Intermediate Value Theorem).
 * Halves the search interval each iteration; converges in O(log2((hi-lo)/tol)) steps.
 * Used as fallback when Newton-Raphson fails (e.g. multiple sign changes in cashflows).
 * @param {number[]} cashflows - Cashflow series
 * @param {number}   lo        - Lower bound of search interval
 * @param {number}   hi        - Upper bound of search interval
 * @param {number}   tol       - Convergence tolerance (default 0.01% = 1bp)
 * @param {number}   maxIter   - Maximum iterations (default 100)
 * @returns {number|null} IRR as decimal, or null if no root in [lo, hi]
 */
function _bisectionIRR(cashflows, lo, hi, tol = 0.0001, maxIter = 100) {
  let fLo = _npv(cashflows, lo);
  let fHi = _npv(cashflows, hi);
  if (fLo * fHi > 0) return null; // no root in interval
  for (let i = 0; i < maxIter; i++) {
    const mid = (lo + hi) / 2;
    const fMid = _npv(cashflows, mid);
    if (Math.abs(fMid) < tol || (hi - lo) / 2 < tol) return mid;
    if (fLo * fMid < 0) { hi = mid; fHi = fMid; } // root in [lo, mid]
    else { lo = mid; fLo = fMid; }                  // root in [mid, hi]
  }
  return (lo + hi) / 2; // best estimate after maxIter
}

/**
 * Multi-strategy IRR solver.
 * Strategy:
 *  1. Newton-Raphson from 10 spread guesses (spans [-50%, 150%]) — fast, handles most cases.
 *  2. Deduplicates roots (< 0.1% apart are considered the same root).
 *  3. If multiple distinct roots found (non-conventional cashflow patterns), pick the one
 *     closest to 15% — typical PE return anchor.
 *  4. If all Newton attempts fail, bisect on [-90%, 500%] — guaranteed convergence if a root exists.
 * @param {number[]} cashflows - Array starting with Y0 outflow (negative), then annual inflows + terminal
 * @returns {number|null} IRR as decimal, or null if unsolvable
 */
export function calculateIRR(cashflows) {
  // Try multiple initial guesses with Newton-Raphson
  const guesses = [-0.5, -0.2, 0.0, 0.05, 0.10, 0.15, 0.25, 0.40, 0.75, 1.5];
  const roots = [];
  for (const g of guesses) {
    const r = _newtonRaphsonIRR(cashflows, g);
    // Only add distinct roots (< 0.1% apart = same root)
    if (r != null && !roots.some(existing => Math.abs(existing - r) < 0.001)) {
      roots.push(r);
    }
  }
  if (roots.length === 1) return roots[0];
  if (roots.length > 1) {
    // Multiple roots found — prefer the one closest to typical PE returns (15%)
    roots.sort((a, b) => Math.abs(a - 0.15) - Math.abs(b - 0.15));
    return roots[0];
  }
  // Newton failed — try bisection on [-0.9, 5.0]
  return _bisectionIRR(cashflows, -0.9, 5.0, 0.0001, 100);
}

// ─── Formatting Helpers ─────────────────────────────────────────────────────
/**
 * Format a number with thousand separators and optional decimals.
 * Negative values are displayed in accounting style: (1,234) rather than -1,234.
 * Null/NaN returns em dash "—".
 */
export const fmt = (v, d = 0) => {
  if (v == null || isNaN(v)) return "—";
  const neg = v < 0;
  const s = Math.abs(v).toFixed(d).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return neg ? `(${s})` : s;
};

/**
 * Format a dollar value in $M, auto-scaling to $B for values ≥ $1B.
 * Rounding before scaling avoids display artifacts (e.g. $0.9B → $900M).
 */
export const fmtM = (v) => {
  const r = Math.round(v);
  if (Math.abs(r) >= 1000) return `$${(r / 1000).toFixed(1)}B`;
  return `$${fmt(r, 0)}M`;
};

/** Format a decimal rate as a percentage with 1 decimal place (e.g. 0.175 → "17.5%"). */
export const fmtPct = (v) => `${fmt(v * 100, 1)}%`;

// ─── Physical & Contract Constants ──────────────────────────────────────────
// These are observed or contractual facts — not model assumptions. Do not make
// these user-editable; adjustments flow through other inputs (goesPrice, etc.).
export const NAMEPLATE = 180000;       // tons/yr — GOES mill nameplate (180 Kt)
export const DOD_TONS = 10600;         // tons/yr — DOD off-take contract volume
export const DOD_PRICE = 7550;         // $/ton — DOD contract price (above market; reflects mission criticality)
export const DOE_CAPACITY = 25000;     // tons/yr — extra capacity added when DOE project goes live
export const DOE_TARGET_SAVINGS = 80;  // $M/yr savings at full NAMEPLATE throughput
export const DOE_SAVINGS_PER_TON = DOE_TARGET_SAVINGS * 1e6 / NAMEPLATE; // ≈$444/ton production cost reduction
export const DOE_RAMP_YEARS = 2;       // years for DOE savings to ramp from 0 to full (linear)
export const FIXED_COST_SHARE_DEFAULT = 0.40; // 40% of production cost is fixed (labor, maintenance, facility overhead)
export const TAX_RATE = 0.25;          // legacy default combined federal+state; overridden by inputs.taxRate
export const DOE_GRANT_AMOUNT = 75;    // $M — one-time DOE grant reducing upfront equity needs
export const INTERNALIZE_FACTOR_DEFAULT = 0.50; // in-house midstream cost as fraction of outsourced rate
export const DUOPOLY_TRANSITION_YEARS = 4; // years for Nippon Steel to ramp to full market presence

// ─── Info Tooltips (re-exported from infoTooltips.js) ─────────────────────
// Display-only content — kept separate from model logic.
// Re-exported here for backward compatibility with any external consumers.
export { INFO } from "./infoTooltips.js";

// ─── Base Defaults (all inputs) ─────────────────────────────────────────────
const BASE = {
  // Steel Mill — utilization ramp (start → target over rampYears)
  goesStartUtil: 0.70, goesTargetUtil: 0.92, goesRampYears: 2,
  goesPrice: 5700, duopolyImpact: 0.17,
  goesProductionCost: 2800, nipponYear: 5, dodOn: true, dodRenewal: true,
  doeOn: false, doeYear: 1,
  goesPriceInflation: 0.035,
  overheadPct: 0.07, // SGA/overhead as % of Steel Mill revenue (replaces fixed $M)
  nonGoesRevenue: 120, nonGoesMargin: 0.15,
  // TX Existing Business — $500M MPT company acquisition
  txExistEnabled: true, txExistStartYear: 2,
  txBaseRevenue: 500, txBaseEBITDAMargin: 0.125,
  // GOES demand mode: "intensity" derives tons from revenue × ratio;
  // "units" uses explicit unit count × GOES/unit (mirrors greenfield approach)
  txDemandMode: "intensity",
  txGOESIntensity: 16,       // tons per $M revenue (range ~5-25; VTC ~10, Delta Star ~17)
  txExistUnits: 0,           // units/yr (detailed "units" mode only)
  txExistGOESPerUnit: 14,    // tons GOES per unit (detailed "units" mode only)
  txAcqMultiple: 15, txAcqNonCoreRevenue: 50, txAcqNonCoreMargin: 0.20,
  // TX Greenfield — capacity expansion
  txGreenfieldEnabled: true, txGfStartYear: 2,
  mpUnits: 150, goesPerMP: 14, mpASP: 1100000,
  mpVarCostPct: 0.38, mpFixedCost: 30, // variable cost ex-GOES as % of ASP; fixed cost $M/yr at full capacity
  mpIntermediatePct: 0.12,
  distUnits: 0, goesPerDist: 0.8, distASP: 22000,
  distVarCostPct: 0.42, distFixedCost: 5, // distribution line fixed/variable split
  distIntermediatePct: 0.08,
  gfLearningCurve: 0.15, // Year 1 variable cost premium (15%), declines to 0 over ramp
  ramp: [0, 0.30, 0.70, 1.0], gfRampYears: 4, greenfieldCapex: 150,
  internalizeIntermediate: false, internalizeFactor: 0.50, // in-house cost as fraction of outsourced (lower = more savings)
  // TX GOES Sourcing
  captivePct: 1.00,
  // Transformer Non-Core (removed — greenfield non-core no longer modeled)
  // Tax
  taxRate: 0.25, // Combined federal + state effective tax rate
  interestCapEnabled: false, // Section 163(j) interest deductibility cap
  interestCapPct: 0.30, // Max deductible interest as % of adjusted taxable income (EBITDA)
  // Capital Structure
  entryMultiple: 8.0, workingCapital: 150, pensionLiability: 0, txnFees: 0.02,
  ltv: 0.60, costOfDebt: 0.07,
  // Returns
  exitMultiple: 10, holdPeriod: 10, exitTxnCosts: 0.025, waccRate: 0.082, waccMode: "manual",
  // Growth & Inflation
  cpiRate: 0.025, txPriceEscalation: 0.05, txEscalationDecay: 0, txCostEscalation: 0.04, terminalGrowth: 0.025,
  // WACC Build-up
  riskFreeRate: 0.041, equityRiskPremium: 0.055, beta: 1.20, sizePremium: 0.02,
  // Working Capital — DSO/DIO/DPO approach
  wcDSO: 55,     // days sales outstanding (receivables)
  wcDIO: 65,     // days inventory outstanding
  wcDPO: 40,     // days payable outstanding
  // Legacy fallback — kept for backward compat, ignored when DSO/DIO/DPO are set
  nwcPctRevenue: 0.15, nwcStartPct: 0.15, nwcRampYears: 3,
  // Debt Structure
  debtAmortYears: 7, // Maturity in years — 0 = interest-only bullet
  debtAmortPct: 0.01, // Annual mandatory amortization as % of outstanding balance (PE standard: 1%)
  minCashBalance: 25, // Minimum cash reserve ($M) before cash sweep applies
  cashSweepPct: 0, // % of excess FCF applied to mandatory debt repayment
  ddtlCommitmentFee: 0.005, // 50bps commitment fee on undrawn DDTL balance
  // Cost Structure
  fixedCostShare: 0.40, // % of GOES production cost that is fixed
  // Covenant Monitoring (expandable)
  covenantMonitoring: false,       // toggle: show covenant compliance in Cash Flow table
  covenantMaxLeverage: 5.0,        // max Net Debt / EBITDA
  covenantMinCoverage: 2.0,        // min EBITDA / Interest
  covenantMinDSCR: 1.2,            // min DSCR (EBITDA - capex - tax) / (interest + amort)
  // Tariff Risk (Section 232)
  tariffRiskEnabled: false,        // toggle: model tariff reduction scenario
  tariffReductionPct: 0.45,        // % reduction in GOES market price if tariffs removed
  tariffRiskYear: 4,               // year tariff change takes effect
  tariffTransitionYears: 2,        // years to fully phase in price reduction
  // Sustaining Capex — % of consolidated revenue (auto-scales with business)
  maintCapexPct: 0.07, // 7% of revenue — maintenance capex
  // D&A — % of revenue (default mode) or component-based (advanced mode)
  daPctRevenue: 0.12, // 12% of revenue — captures step-up, greenfield, bonus dep, capitalized maintenance
  useAdvancedDep: false, // false = use % of revenue; true = compute from components
  // Advanced depreciation schedule (used when useAdvancedDep = true)
  acqDepreciablePct: 0.80, // % of acquisition price allocated to depreciable assets (PP&E + goodwill/intangibles; excludes land ~5%, NWC modeled separately)
  acqDepLife: 15, // Blended straight-line life (PP&E 10-20yr, goodwill/intangibles 15yr per §197)
  gfDepLife: 20, // Greenfield plant depreciation life
  // GP/LP Economics
  mgmtFee: 0.015, // 1.5% of committed equity per year
  carryPct: 0.20, // 20% carried interest
  preferredReturn: 0.08, // 8% preferred return hurdle
  mgmtEquityPct: 0.10, // Management option pool — 10% dilution on sponsor equity
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
//   favDeal   — best-case deal structure (entry/exit & financing)
//
// Each themed scenario is individually plausible: the probability of ONE cluster
// going wrong/right is meaningful, unlike every variable simultaneously at extremes.

const OVERRIDES = {
  base: { label: "Base Case", doeOn: true, txEscalationDecay: 0 },

  // ── Downside: Weak Market ──────────────────────────────────────────────────
  // Stress: GOES pricing, duopoly impact, Nippon timing, non-GOES revenue,
  //         TX margins & ASPs, exit multiple, captive % (all market-correlated)
  // Unchanged: utilization ramp, production costs, deal structure, financing, DOE/DOD
  weakMkt: {
    label: "Weak Market",
    goesPrice: 5000, duopolyImpact: 0.22, nipponYear: 4,
    goesPriceInflation: 0.02, doeOn: true, dodRenewal: true,
    nonGoesRevenue: 100, nonGoesMargin: 0.12,
    // TX existing — weaker margins, lower demand in soft market
    txBaseRevenue: 425, txBaseEBITDAMargin: 0.10, txGOESIntensity: 15,
    txAcqNonCoreRevenue: 40, txAcqNonCoreMargin: 0.17,
    // TX greenfield — moderate ASP compression, delayed start
    txGfStartYear: 3, gfRampYears: 5,
    mpASP: 900000, distASP: 18000, txPriceEscalation: 0.03, txEscalationDecay: 0.015, txCostEscalation: 0.05,
    mpUnits: 100,
    // Market-correlated: exit buyers pay less in weak narrative, less captive consumption
    exitMultiple: 9.5, captivePct: 0.85,
  },

  // ── Downside: Execution Risk ───────────────────────────────────────────────
  // Stress: slow ramp, high production costs, overhead, greenfield delays
  // Unchanged: market pricing, deal terms, financing
  execRisk: {
    label: "Execution Risk",
    goesStartUtil: 0.60, goesTargetUtil: 0.85, goesRampYears: 5,
    goesProductionCost: 3200, overheadPct: 0.09, fixedCostShare: 0.50,
    maintCapexPct: 0.09, daPctRevenue: 0.14,
    // TX existing — delayed integration, slower start, margin spillover
    txExistStartYear: 2, txBaseEBITDAMargin: 0.11,
    // TX greenfield — delayed, slow ramp, cost overruns
    txGfStartYear: 3, gfRampYears: 5,
    ramp: [0, 0.20, 0.50, 0.80, 1.0], greenfieldCapex: 200,
    mpVarCostPct: 0.44, mpFixedCost: 35, mpIntermediatePct: 0.14,
    distVarCostPct: 0.48, distFixedCost: 6, distIntermediatePct: 0.10,
    gfLearningCurve: 0.20,
    doeOn: true, doeYear: 3,
    wcDSO: 70, wcDIO: 80, wcDPO: 30,
    // Captive sourcing hedge — quality issues force some external GOES purchasing
    captivePct: 0.90, nonGoesMargin: 0.13,
    exitMultiple: 10,
    txEscalationDecay: 0.005, txCostEscalation: 0.05,
  },

  // ── Downside: Adverse Financing ────────────────────────────────────────────
  // Stress: entry/exit multiples, cost of debt, leverage, pension, acquisition pricing
  // Unchanged: operations, market pricing
  advFin: {
    label: "Adverse Financing",
    entryMultiple: 9.0, exitMultiple: 7.5, workingCapital: 110,
    pensionLiability: 400,
    ltv: 0.45, costOfDebt: 0.08, cashSweepPct: 0.50,
    // TX acquisition — overpay in competitive auction
    txAcqMultiple: 19,
    waccRate: 0.108, terminalGrowth: 0.02,
    riskFreeRate: 0.045, beta: 1.35, sizePremium: 0.025,
  },

  // ── Upside: Strong Market ──────────────────────────────────────────────────
  // Stress: GOES pricing up, competition delayed, DOE on, strong TX demand
  // Cross-cluster: exit multiple (decade of strong fundamentals → elevated exit)
  // Adjusted: greenfield capex (accelerated build premium), non-core margin (op leverage)
  strongMkt: {
    label: "Strong Market",
    goesPrice: 6500, duopolyImpact: 0.12, nipponYear: 7,
    goesPriceInflation: 0.05, doeOn: true, doeYear: 2,
    nonGoesRevenue: 150, nonGoesMargin: 0.18,
    // TX existing — strong backlog, higher margins from electrification boom
    txBaseRevenue: 600, txBaseEBITDAMargin: 0.15, txGOESIntensity: 17,
    txAcqNonCoreRevenue: 75, txAcqNonCoreMargin: 0.25,
    // TX greenfield — early start, strong ASPs, larger scale
    txGfStartYear: 1, gfRampYears: 3, greenfieldCapex: 175,
    mpASP: 1500000, distASP: 28000, txPriceEscalation: 0.07, txCostEscalation: 0.035,
    mpUnits: 200,
    // Exit — decade of secular tailwinds capitalized into valuations
    exitMultiple: 12,
  },

  // ── Upside: Operational Excellence ─────────────────────────────────────────
  // Stress: fast ramp, low costs, lean overhead, efficient greenfield
  // Unchanged: market pricing, deal terms, CPI (macro — not ops-controllable)
  opsExcel: {
    label: "Ops Excellence",
    goesStartUtil: 0.85, goesTargetUtil: 0.95, goesRampYears: 1,
    goesProductionCost: 2400, overheadPct: 0.05, fixedCostShare: 0.35,
    maintCapexPct: 0.06, daPctRevenue: 0.10,
    // TX greenfield — accelerated build, low costs, fast ramp
    txGfStartYear: 1, gfRampYears: 3,
    mpVarCostPct: 0.32, mpFixedCost: 25, mpIntermediatePct: 0.10,
    distVarCostPct: 0.35, distFixedCost: 4, distIntermediatePct: 0.06,
    gfLearningCurve: 0.10,
    greenfieldCapex: 120, internalizeIntermediate: true,
    exitMultiple: 11.5,
    doeOn: true, doeYear: 1,
    wcDSO: 40, wcDIO: 50, wcDPO: 50,
    txCostEscalation: 0.03,
  },

  // ── Upside: Best-Case Deal Structure ───────────────────────────────────────
  // Stress: cheap entry, rich exit, good leverage terms, bargain TX acquisition
  // Unchanged: operations, market pricing (base operations assumed)
  favDeal: {
    label: "Best-Case Deal",
    entryMultiple: 7.0, exitMultiple: 13,
    ltv: 0.60, costOfDebt: 0.065,
    // TX acquisition — bargain price in distressed / off-market deal
    txAcqMultiple: 11,
    waccRate: 0.072, terminalGrowth: 0.03,
    riskFreeRate: 0.035, beta: 1.05, sizePremium: 0.015,
  },

  // ── Structural Scenarios ───────────────────────────────────────────────────
  goesOnly: {
    label: "GOES Only",
    txExistEnabled: false, txGreenfieldEnabled: false,
    mpUnits: 0, distUnits: 0, greenfieldCapex: 0, captivePct: 0,
    doeOn: false,                   // explicit: DOE grant excluded for conservative standalone underwriting
    entryMultiple: 7.5,             // standalone steel comps (6-8x); no integration optionality premium
    exitMultiple: 9.5,              // pure-play steel exit (8-10x); post-duopoly limits narrative
    maintCapexPct: 0.08, daPctRevenue: 0.13,
    overheadPct: 0.08,              // higher standalone corporate costs without shared services
    workingCapital: 100, ltv: 0.50, // WC raised from 75 to align with 15% ongoing NWC rate
    waccRate: 0.095,                // +130bps vs base: leverage effect + concentration risk premium
  },
  vtc: {
    label: "VTC Acquisition",
    goesStartUtil: 0.67, goesTargetUtil: 0.95, goesRampYears: 3, doeOn: true, doeYear: 2,
    txExistEnabled: true, txExistStartYear: 1, txGreenfieldEnabled: true, txGfStartYear: 3,
    txBaseRevenue: 4000, txBaseEBITDAMargin: 0.25, txGOESIntensity: 10,
    txAcqMultiple: 15, txAcqNonCoreRevenue: 200, txAcqNonCoreMargin: 0.15,
    mpUnits: 100, distUnits: 0, gfRampYears: 4, greenfieldCapex: 250,
    workingCapital: 200, exitMultiple: 12, maintCapexPct: 0.07, daPctRevenue: 0.12,
    txEscalationDecay: 0.005,
  },
  deltaStar: {
    label: "Delta Star",
    goesStartUtil: 0.65, goesTargetUtil: 0.88, goesRampYears: 3,
    txExistEnabled: true, txExistStartYear: 1, txGreenfieldEnabled: true, txGfStartYear: 2,
    txBaseRevenue: 150, txBaseEBITDAMargin: 0.20, txGOESIntensity: 17,
    txAcqMultiple: 10, txAcqNonCoreRevenue: 25, txAcqNonCoreMargin: 0.20,
    mpUnits: 150, gfRampYears: 4, greenfieldCapex: 175,
    exitMultiple: 10, maintCapexPct: 0.06, daPctRevenue: 0.11,
    txEscalationDecay: 0.005,
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
  strongMkt: "Strong Market", opsExcel: "Ops Excellence", favDeal: "Best-Case Deal",
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
  goesPrice: { bear: 5000, base: 5700, bull: 6500 },
  duopolyImpact: { bear: 0.22, base: 0.17, bull: 0.12 },
  goesProductionCost: { bear: 3200, base: 2800, bull: 2400 },
  nipponYear: { bear: 4, base: 5, bull: 7 },
  doeYear: { bear: 3, base: 1, bull: 2 },
  nonGoesRevenue: { bear: 100, base: 120, bull: 150 },
  nonGoesMargin: { bear: 0.12, base: 0.15, bull: 0.18 },
  mpUnits: { bear: 150, base: 300, bull: 450 },
  goesPerMP: { bear: 16, base: 14, bull: 12 },
  mpASP: { bear: 900000, base: 1100000, bull: 1500000 },
  mpVarCostPct: { bear: 0.44, base: 0.38, bull: 0.32 },
  mpFixedCost: { bear: 35, base: 30, bull: 25 },
  distUnits: { bear: 0, base: 0, bull: 2000 },
  distASP: { bear: 18000, base: 22000, bull: 28000 },
  distVarCostPct: { bear: 0.48, base: 0.42, bull: 0.35 },
  distFixedCost: { bear: 6, base: 5, bull: 4 },
  gfLearningCurve: { bear: 0.20, base: 0.15, bull: 0.10 },
  captivePct: { bear: 0.50, base: 1.00, bull: 1.00 },
  entryMultiple: { bear: 9, base: 8, bull: 7 },
  greenfieldCapex: { bear: 200, base: 150, bull: 100 },
  ltv: { bear: 0.45, base: 0.60, bull: 0.60 },
  costOfDebt: { bear: 0.08, base: 0.07, bull: 0.065 },
  debtAmortPct: { bear: 0.01, base: 0.01, bull: 0.05 },
  minCashBalance: { bear: 50, base: 25, bull: 10 },
  ddtlCommitmentFee: { bear: 0.0075, base: 0.005, bull: 0.0025 },
  exitMultiple: { bear: 9, base: 10, bull: 13 },
  exitTxnCosts: { bear: 0.035, base: 0.025, bull: 0.015 },
  holdPeriod: { bear: 12, base: 10, bull: 7 },
  maintCapexPct: { bear: 0.09, base: 0.07, bull: 0.05 },
  daPctRevenue: { bear: 0.14, base: 0.12, bull: 0.10 },
  pensionLiability: { bear: 400, base: 0, bull: 0 },
  goesPriceInflation: { bear: 0.02, base: 0.035, bull: 0.05 },
  cpiRate: { bear: 0.035, base: 0.025, bull: 0.020 },
  txPriceEscalation: { bear: 0.03, base: 0.05, bull: 0.07 },
  txEscalationDecay: { bear: 0.015, base: 0, bull: 0 },
  txCostEscalation: { bear: 0.05, base: 0.04, bull: 0.03 },
  txExistStartYear: { bear: 3, base: 2, bull: 1 },
  txGfStartYear: { bear: 3, base: 2, bull: 1 },
  txBaseRevenue: { bear: 100, base: 500, bull: 4000 },
  txBaseEBITDAMargin: { bear: 0.10, base: 0.125, bull: 0.15 },
  txGOESIntensity: { bear: 15, base: 16, bull: 17 },
  txAcqMultiple: { bear: 20, base: 15, bull: 10 },
  txAcqNonCoreRevenue: { bear: 35, base: 50, bull: 75 },
  txAcqNonCoreMargin: { bear: 0.15, base: 0.20, bull: 0.25 },
  gfRampYears: { bear: 5, base: 4, bull: 3 },
  terminalGrowth: { bear: 0.02, base: 0.025, bull: 0.03 },
  riskFreeRate: { bear: 0.045, base: 0.041, bull: 0.035 },
  beta: { bear: 1.35, base: 1.20, bull: 1.05 },
  sizePremium: { bear: 0.025, base: 0.02, bull: 0.015 },
  wcDSO: { bear: 70, base: 55, bull: 40 },
  wcDIO: { bear: 80, base: 65, bull: 50 },
  wcDPO: { bear: 30, base: 40, bull: 50 },
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
    nipponYear, dodRenewal, doeOn, doeYear,
    goesPriceInflation, overheadPct,
    nonGoesRevenue, nonGoesMargin,
    txExistEnabled, txExistStartYear, txBaseRevenue, txBaseEBITDAMargin,
    txDemandMode, txGOESIntensity, txExistUnits, txExistGOESPerUnit,
    txAcqMultiple, txAcqNonCoreRevenue, txAcqNonCoreMargin,
    txGreenfieldEnabled, txGfStartYear,
    mpUnits, goesPerMP, mpASP,
    mpIntermediatePct,
    distUnits, goesPerDist, distASP,
    distIntermediatePct,
    ramp, gfRampYears, greenfieldCapex, internalizeIntermediate,
    captivePct,
    taxRate, interestCapEnabled, interestCapPct,
    entryMultiple, workingCapital, pensionLiability, txnFees,
    ltv, costOfDebt,
    exitMultiple, holdPeriod, exitTxnCosts, waccMode, waccRate,
    cpiRate, txPriceEscalation, txEscalationDecay, txCostEscalation, terminalGrowth,
    riskFreeRate, equityRiskPremium, beta, sizePremium,
    debtAmortYears, debtAmortPct, minCashBalance, cashSweepPct, ddtlCommitmentFee, maintCapexPct, fixedCostShare,
    daPctRevenue, useAdvancedDep,
    acqDepreciablePct, acqDepLife, gfDepLife,
    tariffRiskEnabled, tariffReductionPct, tariffRiskYear, tariffTransitionYears,
  } = p;

  const goesStartUtil = p.goesStartUtil ?? BASE.goesStartUtil;
  const goesTargetUtil = p.goesTargetUtil ?? goesStartUtil;
  const goesRampYears = p.goesRampYears ?? BASE.goesRampYears;

  // ── Working capital: CCC → structural NWC % of revenue ──
  // Cash Conversion Cycle = DSO + DIO - DPO (all in days).
  // NWC as % of revenue = CCC / 365. This is the structural (steady-state) rate;
  // delta NWC each year reflects incremental revenue growth, not a ramp to a target.
  // Example: DSO=55, DIO=65, DPO=40 → CCC=80d → NWC=21.9% of revenue.
  const wcDSO = p.wcDSO ?? BASE.wcDSO;
  const wcDIO = p.wcDIO ?? BASE.wcDIO;
  const wcDPO = p.wcDPO ?? BASE.wcDPO;
  const ccc = wcDSO + wcDIO - wcDPO;   // total cash cycle in days
  const nwcPctFromCCC = ccc / 365;      // fraction of annual revenue tied up in working capital

  const goesPrice = p.goesPrice ?? BASE.goesPrice;
  const duopolyImpact = p.duopolyImpact ?? BASE.duopolyImpact;
  // Post-duopoly equilibrium price: current price compressed by duopolyImpact fraction.
  // For example, $5,700/t with 17% impact → $4,731/t. The year-by-year loop blends
  // from goesPrice to goesPostDuopolyPrice as duoBlend transitions 0→1.
  const goesPostDuopolyPrice = goesPrice * (1 - duopolyImpact);

  // ── Greenfield cost structure ──
  // Variable cost: % of ASP (ex-GOES — transformer assembly, wiring, testing).
  // Fixed cost: $M/yr at full capacity (facility O&M, salaried labor, insurance).
  // Learning curve: Year 1 has a gfLearningCurve premium on variable costs (captures
  // ramp-up inefficiency, scrap, overtime, etc.) that declines linearly to 0 by gfRampYears.
  const mpVarCostPct = p.mpVarCostPct ?? BASE.mpVarCostPct;
  const mpFixedCost = p.mpFixedCost ?? BASE.mpFixedCost;
  const distVarCostPct = p.distVarCostPct ?? BASE.distVarCostPct;
  const distFixedCost = p.distFixedCost ?? BASE.distFixedCost;
  const gfLearningCurve = p.gfLearningCurve ?? BASE.gfLearningCurve;
  // Internalization savings: intermediate processing (e.g. core lamination, insulation)
  // currently outsourced at market rate. If internalized, cost is intFactor × market rate.
  // Net savings = (1 - intFactor) × intermediate %. Removed from variable cost %.
  const intFactor = p.internalizeFactor ?? INTERNALIZE_FACTOR_DEFAULT;
  const mpIntermSavings = internalizeIntermediate ? mpIntermediatePct * (1 - intFactor) : 0;
  const distIntermSavings = internalizeIntermediate ? distIntermediatePct * (1 - intFactor) : 0;
  const mpEffVarCostPct = mpVarCostPct - mpIntermSavings;   // net variable cost after any internalization
  const distEffVarCostPct = distVarCostPct - distIntermSavings;

  // Covenant monitoring
  const covenantMonitoring = p.covenantMonitoring ?? false;
  const covenantMaxLeverage = p.covenantMaxLeverage ?? 5.0;
  const covenantMinCoverage = p.covenantMinCoverage ?? 2.0;
  const covenantMinDSCR = p.covenantMinDSCR ?? 1.2;

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
  // Two modes:
  //   "manual" — directly use waccRate (faster, typical for LBO screens).
  //   "buildup" — compute via CAPM build-up:
  //     Ke = Rf + β × ERP + size premium (modified CAPM with size premium for small/mid-cap)
  //     Kd (after-tax) = costOfDebt × (1 - taxRate)
  //     WACC = (1 - LTV) × Ke + LTV × Kd_at  (weights at deal LTV structure)
  // Note: WACC at entry leverage may understate cost of equity at maturity (as debt repays,
  // equity proportion grows and the effective discount rate should increase). We hold WACC
  // constant for simplicity — standard PE screening practice.
  let wacc, ke, kdAfterTax;
  if (waccMode === "manual") {
    wacc = waccRate;
    ke = null;
    kdAfterTax = null;
  } else {
    // CAPM + size premium (Duff & Phelps / Kroll build-up method)
    ke = riskFreeRate + beta * equityRiskPremium + sizePremium;
    kdAfterTax = costOfDebt * (1 - taxRate); // interest tax shield reduces effective cost of debt
    wacc = (1 - ltv) * ke + ltv * kdAfterTax;
  }

  // ── Y1 normalized Steel Mill EBITDA (for entry valuation) ──
  // Standalone means no captive — all production sold externally.
  // Entry valuation uses current (pre-duopoly) market price, since the seller
  // prices the business on today's EBITDA. Duopoly risk is a future headwind
  // that reduces IRR — if the buyer wants to discount for it at entry, they
  // adjust the entry multiple. This ensures higher duopolyImpact → lower IRR.
  // Y1 EBITDA uses starting utilization (current operations) for entry valuation
  // DOE benefit is excluded from entry valuation — the grant is unlocked
  // post-acquisition, so the seller prices on pre-DOE economics.
  const y1Prod = NAMEPLATE * goesStartUtil;
  const y1PC = goesProductionCost;
  const y1MP = goesPrice; // Entry valuation at current market price
  const y1DodT = DOD_TONS; // DOD contract is signed — always active
  const y1TPT = Math.max(0, y1Prod - y1DodT);
  const y1GoesRev = (y1TPT * y1MP + y1DodT * DOD_PRICE) / 1e6;
  const y1GoesCOGS = (y1Prod * y1PC) / 1e6;
  const y1GoesGP = y1GoesRev - y1GoesCOGS;
  const y1NonGoesGP = nonGoesRevenue * nonGoesMargin;
  const y1SegRev = y1GoesRev + nonGoesRevenue;
  const y1ButlerEBITDA = y1GoesGP + y1NonGoesGP - (y1SegRev * overheadPct);

  // ── Sources & Uses — timing-aware capital deployment ──
  // Butler + WC + pension + fees always deploy at Y0 (simultaneous close).
  // TX acquisition deploys at txExistStartYear - 1 (bolt-on closes one year before first EBITDA year).
  // Greenfield capex deploys at txGfStartYear - 1 (construction starts before production begins).
  // When start year is 1, deploy year = 0 (simultaneous close with Butler acquisition).
  //
  // The DDTL (Delayed-Draw Term Loan) structure allows the full facility to be committed at
  // close while drawing only what's needed at each stage — deferred capex draws down the
  // undrawn commitment with commitment fees on the undrawn balance.
  const y1EBITDAFloored = y1ButlerEBITDA < 50; // flag: Y1 EBITDA below $50M floor (edge case)
  const y1EBITDAActual = y1ButlerEBITDA;
  // Acquisition price = entry multiple × Y1 EBITDA (floored to $50M to avoid trivial/negative values)
  const butlerAcqPrice = Math.round(entryMultiple * Math.max(y1ButlerEBITDA, 50));
  const effTxAcqPrice = txExistActive ? txAcqPrice : 0;
  const effGfCapex = txGfActive ? greenfieldCapex : 0;
  // Transaction fees applied to acquisition prices only (not WC, capex, or pension)
  const txnFeesAmt = (butlerAcqPrice + effTxAcqPrice) * txnFees;
  const doeGrantAmt = doeOn ? DOE_GRANT_AMOUNT : 0; // $75M grant reduces total investment

  // Deployment years (floored to 0 — can't deploy before close)
  const txAcqDeployYear = txExistActive ? Math.max(0, txExistStartYear - 1) : 0;
  const gfCapexDeployYear = txGfActive ? Math.max(0, txGfStartYear - 1) : 0;

  // Y0 uses: all items that deploy at the moment of close
  const y0Uses = butlerAcqPrice + workingCapital + pensionLiability + txnFeesAmt
    + (txAcqDeployYear === 0 ? effTxAcqPrice : 0)
    + (gfCapexDeployYear === 0 ? effGfCapex : 0);

  // Total lifetime uses (used for display only — IRR cashflows use timing-aware flows)
  const totalUses = butlerAcqPrice + effTxAcqPrice + effGfCapex + workingCapital + pensionLiability + txnFeesAmt;
  const ti = totalUses - doeGrantAmt; // net total investment after DOE grant
  // Debt sized as LTV × total investment (committed facility covers all deployment years)
  const debtInitial = ti * ltv;
  const eq = ti - debtInitial; // sponsor equity
  // Annual mandatory amortization = debtAmortPct × BOY outstanding (1% is typical PE "cash sweep lite")
  // debtAmortYears = debt maturity (bullet payment); model tracks against this with warnings

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
    const dodT = DOD_TONS;
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
  if (txAcqDeployYear > holdPeriod) warnings.push(`TX acquisition deployment (Y${txAcqDeployYear}) is beyond the ${holdPeriod}-year hold period.`);
  if (txGfActive && gfCapexDeployYear > holdPeriod) warnings.push(`Greenfield capex deployment (Y${gfCapexDeployYear}) is beyond the ${holdPeriod}-year hold period.`);
  // Greenfield ramp vs hold period warning
  if (txGfActive && gfRampYears > 0) {
    const fullRampYear = (txGfStartYear || 1) + gfRampYears;
    const yearsAtScale = holdPeriod - fullRampYear;
    if (yearsAtScale <= 2 && yearsAtScale >= 0) {
      warnings.push(`Greenfield reaches full capacity at Y${fullRampYear} — only ${yearsAtScale} year${yearsAtScale !== 1 ? "s" : ""} at full scale before exit.`);
    } else if (yearsAtScale < 0) {
      warnings.push(`Greenfield doesn't reach full capacity until Y${fullRampYear} — after the ${holdPeriod}-year hold period ends.`);
    }
  }

  // ── DDTL: track drawn vs. undrawn commitment ──
  // Structure: bank commits the full debtInitial facility at close, but only funds draws
  // as capital is actually deployed. Commitment fee (ddtlCommitmentFee) accrues on the
  // undrawn portion each year.
  // - totalCommitted = full facility size (fixed at close)
  // - cumulativeDrawn = cumulative draws (only increases — amortization doesn't un-draw)
  // - debtBal = outstanding principal (decreases as amortization and sweeps pay it down)
  // - undrawnCommitment = totalCommitted - cumulativeDrawn (decreases as draws happen)
  const totalCommitted = debtInitial;
  const y0Debt = (y0Uses - doeGrantAmt) * ltv; // debt portion of Y0 deployment (DOE grant offsets need)
  // cumulativeDrawn tracks total ever drawn; capped at totalCommitted to avoid over-draw
  let cumulativeDrawn = Math.min(y0Debt, totalCommitted);

  // ── Year-by-year projections ──
  const years = []; // index 0 = Y0 (entry), 1..holdPeriod = operating years
  let cumUFCF = 0;  // running total of unlevered FCF (used for payback and display)
  let cumLFCF = 0;  // running total of levered FCF (used for payback and DPI)
  // prevNWC initialized to workingCapital (closing balance) so Y1 deltaNWC only reflects the
  // incremental working capital needed for post-acquisition revenue growth, not a step from zero.
  let prevNWC = workingCapital;
  let debtBal = Math.min(y0Debt, totalCommitted); // outstanding drawn principal
  // TCJA §172 (Tax Cuts and Jobs Act, 2017): post-2017 NOL carryforwards can offset up to 80%
  // of taxable income per year (no carryback). Two parallel balances:
  let nolBalance = 0;           // levered NOL: based on EBT (after interest deduction)
  let nolBalanceUnlevered = 0;  // unlevered NOL: based on EBIT (for UFCF/DCF tax calc)
  let disallowedInterestBalance = 0; // §163(j) carryforward: disallowed interest in prior years

  for (let y = 0; y <= holdPeriod; y++) {
    if (y === 0) {
      // Y0 = Entry Basis: normalized P&L at starting utilization & current pricing.
      // This is the earnings profile the acquisition price is based on.
      // Standalone Steel Mill only — no TX segment at entry.
      const z = zeroYear();
      z.utilY = goesStartUtil;
      z.production = y1Prod;
      z.prodCost = y1PC;
      z.mktPrice = y1MP;
      z.dodTons = y1DodT;
      z.thirdPartyTons = y1TPT;
      z.dodRevenue = (y1DodT * DOD_PRICE) / 1e6;
      z.thirdPartyRevenue = (y1TPT * y1MP) / 1e6;
      z.goesExtRev = y1GoesRev;
      z.nonGoesRevY = nonGoesRevenue;
      z.goesCOGS = y1GoesCOGS;
      z.goesGP = y1GoesGP;
      z.nonGoesGP = y1NonGoesGP;
      z.goesSegRev = y1SegRev;
      z.overheadY = y1SegRev * overheadPct;
      z.goesEBITDA = y1ButlerEBITDA;
      z.goesMargin = y1SegRev > 0 ? y1ButlerEBITDA / y1SegRev : 0;
      z.totalRev = y1SegRev;
      z.totalEBITDA = y1ButlerEBITDA;
      z.margin = y1SegRev > 0 ? y1ButlerEBITDA / y1SegRev : 0;
      z.debtBal = debtBal;
      z.drawnBalance = debtBal;
      z.undrawnCommitment = Math.max(0, totalCommitted - cumulativeDrawn);
      years.push(z);
      continue;
    }

    // ── Greenfield ramp factor ──
    // computeRamp returns 0 before greenfield start, linear 0→1 over gfRampYears after.
    const rp = computeRamp(y);

    // ── Escalation factors ──
    // All are cumulative (compound) from Y1 base. Y1 = base (no escalation applied yet).
    const cpiEsc = Math.pow(1 + cpiRate, y - 1); // CPI compounding from Y1

    // TX price escalation with optional annual decay: rate starts at txPriceEscalation,
    // declines by txEscalationDecay each year (models fading contract escalation), floored at CPI.
    // Computed iteratively (not Math.pow) because the rate itself changes each year.
    let txPriceEsc = 1;
    for (let yr = 1; yr < y; yr++) {
      const rate = Math.max(cpiRate, txPriceEscalation - txEscalationDecay * (yr - 1));
      txPriceEsc *= (1 + rate);
    }
    const txCostEsc = Math.pow(1 + txCostEscalation, y - 1); // transformer cost escalation (supply chain CPI)
    const nonGoesEsc = cpiEsc; // non-GOES steel products track general CPI

    // ── DOE benefit ramp ──
    // Ramps linearly from 0 at doeYear to 1.0 over DOE_RAMP_YEARS.
    // doeBlend=0 → no benefit; doeBlend=1 → full $444/ton savings and +25Kt capacity.
    const doeBlend = doeOn ? Math.min(1, Math.max(0, (y - doeYear + 1) / DOE_RAMP_YEARS)) : 0;
    const doeActive = doeBlend > 0;

    // ── Duopoly price transition ──
    // Nippon Steel's market entry begins at nipponYear, with GOES prices transitioning
    // from monopoly level (goesPrice) to duopoly equilibrium (goesPostDuopolyPrice)
    // over DUOPOLY_TRANSITION_YEARS (4 years). Before nipponYear: duoBlend=0 (full price).
    // At nipponYear+DUOPOLY_TRANSITION_YEARS-1: duoBlend=1 (fully compressed price).
    const duoBlend = Math.min(1, Math.max(0, (y - nipponYear + 1) / DUOPOLY_TRANSITION_YEARS));
    const duo = duoBlend > 0; // flag: duopoly transition has begun
    const priceEsc = Math.pow(1 + goesPriceInflation, y - 1); // GOES nominal price inflation (from Y1)

    // ── Section 232 tariff risk ──
    // If tariffs are reduced/removed, GOES market price would compress (import competition).
    // DOD contract is insulated (government contract), so tariffAdj applies to third-party price only.
    // Phase-in: tariffAdj ramps from 0 at tariffRiskYear to tariffReductionPct over tariffTransitionYears.
    const tariffAdj = tariffRiskEnabled && y >= tariffRiskYear
      ? Math.min(tariffReductionPct, tariffReductionPct * Math.min(1, (y - tariffRiskYear + 1) / Math.max(1, tariffTransitionYears)))
      : 0;

    // Market price: blend pre/post duopoly, then apply tariff adjustment, then apply price inflation.
    // Order matters: tariff and duopoly are price-level effects (fraction); inflation compounds on top.
    const mktPrice = (goesPrice * (1 - duoBlend) + goesPostDuopolyPrice * duoBlend) * (1 - tariffAdj) * priceEsc;

    // ── GOES production ──
    // Utilization ramps linearly from goesStartUtil to goesTargetUtil over goesRampYears.
    // DOE adds 25Kt capacity (ramps separately via doeBlend). Production = min(util×NAMEPLATE, cap).
    const utilBlend = goesRampYears > 0 ? Math.min(1, (y - 1) / goesRampYears) : 1;
    const utilY = goesStartUtil + (goesTargetUtil - goesStartUtil) * utilBlend;
    const cap = NAMEPLATE + (DOE_CAPACITY * doeBlend); // effective annual capacity (tons)
    const production = Math.min(NAMEPLATE * utilY, cap); // can't exceed physical capacity

    // ── Fixed cost absorption ──
    // Fixed costs (labor, maintenance, facility) are spread over actual production tons.
    // At goesStartUtil: fixedPerTon = goesProductionCost × fixedCostShare (no adjustment).
    // At higher utilization: same total fixed cost / more tons → lower $/ton → lower COGS.
    // This correctly models operating leverage in the steel business.
    const fixedPerTon = goesProductionCost * fixedCostShare * goesStartUtil / utilY;
    const variablePerTon = goesProductionCost * (1 - fixedCostShare); // constant per ton
    // DOE savings reduce production cost $/ton by DOE_SAVINGS_PER_TON × doeBlend (phased in).
    // CPI escalation applied to full prodCost (both fixed and variable escalate with input inflation).
    const prodCost = (fixedPerTon + variablePerTon - DOE_SAVINGS_PER_TON * doeBlend) * cpiEsc;

    // ── DOD contract ──
    // DOD 5-year contract is active Y1-Y5 by default. dodRenewal extends it through holdPeriod.
    const dodActive = y <= 5 || dodRenewal;
    const dodTons = dodActive ? DOD_TONS : 0; // 10,600 t/yr at premium price

    // ── Transformer GOES demand ──
    // GOES consumed by the TX segment each year. Two sources:
    //   Greenfield: mpUnits × rp × goesPerMP + distUnits × rp × goesPerDist (scales with ramp)
    //   Existing:   txBaseGOESDemand (pre-computed from intensity or units mode; constant once started)
    const gfStarted = txGfActive && y >= txGfStartYear;
    const existStarted = txExistActive && y >= txExistStartYear;
    const mpUnitsY = gfStarted ? mpUnits * rp : 0;   // medium power units produced this year
    const distUnitsY = gfStarted ? distUnits * rp : 0; // distribution units produced this year
    const gfGOESDemand = mpUnitsY * goesPerMP + distUnitsY * goesPerDist;
    const existGOESDemand = existStarted ? txBaseGOESDemand : 0;
    const totalTXGOESDemand = gfGOESDemand + existGOESDemand;

    // ── Captive allocation with physical constraint ──
    // "Spare" = production after DOD contract is fulfilled. Captive demand is preferred
    // (lower-cost internal supply vs. buying at market), but hard-capped by spare capacity.
    // Any demand exceeding spare capacity is sourced from the open market (marketPurchase).
    // captiveCapped flag triggers a warning when the constraint bites.
    const spare = Math.max(0, production - dodTons);
    const desiredCaptive = totalTXGOESDemand * captivePct; // target captive tons (% of demand)
    const actualCaptive = Math.min(desiredCaptive, spare); // capped by available production
    const marketPurchase = totalTXGOESDemand - actualCaptive; // deficit sourced from market
    const captiveCapped = desiredCaptive > spare; // true when production can't meet captive target

    // ── GOES segment P&L ──
    // Third-party = all production not going to DOD or captive TX supply.
    // COGS is on ALL production tons (including captive); the captive "cost" is absorbed
    // within the TX segment (gfGOESCostCap). The GOES gross profit reflects full production cost.
    const thirdPartyTons = Math.max(0, production - dodTons - actualCaptive);
    const dodRevenue = (dodTons * DOD_PRICE) / 1e6;         // premium-priced DOD contract
    const thirdPartyRevenue = (thirdPartyTons * mktPrice) / 1e6; // market-priced external sales
    const goesExtRev = dodRevenue + thirdPartyRevenue;       // total external GOES revenue ($M)
    const goesCOGS = (production * prodCost) / 1e6;          // all-in production cost ($M)
    const goesGP = goesExtRev - goesCOGS;                    // GOES gross profit (before OH)

    // Non-GOES (roll-forming, slitting, other value-added products): tracks CPI
    const nonGoesRevY = nonGoesRevenue * nonGoesEsc;
    const nonGoesGP = nonGoesRevY * nonGoesMargin;

    // Overhead (SG&A) as % of Steel Mill segment total revenue (replaces fixed $M approach).
    // Scales with revenue so expansion doesn't artificially inflate margins.
    const overheadY = (goesExtRev + nonGoesRevY) * overheadPct;
    const goesEBITDA = goesGP + nonGoesGP - overheadY;
    const goesSegRev = goesExtRev + nonGoesRevY;
    const goesMargin = goesSegRev > 0 ? goesEBITDA / goesSegRev : 0;

    // ── Transformer Existing Business ──
    // Pre-integration EBITDA = txBaseRevenue × margin (base case; escalates with TX price index).
    // Captive advantage: captive GOES is valued at prodCost (not mktPrice), so savings =
    //   (mktPrice - prodCost) × captive tons. This advantage is proportionally allocated
    //   between Existing and Greenfield based on their share of total TX GOES demand.
    const txExistRevY = existStarted ? txBaseRevenue * txPriceEsc : 0;
    const txExistEBITDA_pre = txExistRevY * txBaseEBITDAMargin; // pre-integration EBITDA
    // existFrac = Existing's share of total TX GOES demand (for pro-rata captive allocation)
    const existFrac = totalTXGOESDemand > 0 ? existGOESDemand / totalTXGOESDemand : 0;
    const existCaptive = actualCaptive * existFrac; // tons of captive GOES used by Existing TX
    // Captive advantage: savings from internal supply vs. open-market purchase
    const captiveAdvExist = existCaptive * (mktPrice - prodCost) / 1e6;
    const adjExistEBITDA = txExistEBITDA_pre + captiveAdvExist; // integration-adjusted EBITDA
    // Non-core (grid equipment, ancillary products acquired with the TX company):
    const txAcqNCRevY = existStarted ? txAcqNonCoreRevenue * txPriceEsc : 0;
    const txAcqNCEBITDA = txAcqNCRevY * txAcqNonCoreMargin;

    // ── Transformer Greenfield ──
    // Revenue: units × ASP (escalated by txPriceEsc). Units scale with ramp factor rp.
    // GOES cost: split between captive (at prodCost) and market purchase (at mktPrice).
    // The gfFrac is Greenfield's share of total TX GOES demand.
    const mpRevY = (mpUnitsY * mpASP * txPriceEsc) / 1e6;
    const distRevY = (distUnitsY * distASP * txPriceEsc) / 1e6;
    // GOES cost for greenfield: proportionally allocated from the aggregate captive/market pools
    const gfFrac = totalTXGOESDemand > 0 ? gfGOESDemand / totalTXGOESDemand : 0;
    const gfCaptive = actualCaptive * gfFrac;          // captive tons allocated to greenfield
    const gfMarketPurchase = marketPurchase * gfFrac;  // market-sourced tons for greenfield
    const gfGOESCostCap = (gfCaptive * prodCost) / 1e6;    // captive at cost-of-production
    const gfGOESCostMkt = (gfMarketPurchase * mktPrice) / 1e6; // market purchase at spot price
    const gfGOESCost = gfGOESCostCap + gfGOESCostMkt;     // total GOES input cost for greenfield
    // Operating costs: fixed/variable split
    // Variable cost: % of ASP, scaled by learning premium (startup inefficiency) and cost inflation.
    // Learning curve declines linearly from (1 + gfLearningCurve) to 1.0 by yRel = gfRampYears.
    const yRel = y - (txGfStartYear || 1) + 1; // years since greenfield production start
    const learningPremium = gfLearningCurve > 0 && gfRampYears > 0
      ? gfLearningCurve * Math.max(0, 1 - (yRel - 1) / gfRampYears) // ramps down to 0 by gfRampYears
      : 0;
    // Variable costs: % of ASP, with learning premium and internalization savings, escalated by supply chain CPI
    const mpVarCostY = (mpUnitsY * mpASP * mpEffVarCostPct * (1 + learningPremium) * txCostEsc) / 1e6;
    const distVarCostY = (distUnitsY * distASP * distEffVarCostPct * (1 + learningPremium) * txCostEsc) / 1e6;
    // Fixed costs: $M/yr at capacity, scaled by fixedRampFrac.
    // Even at low utilization, you incur ~50% of fixed costs (staffed facility, committed leases).
    // The other 50% is semi-variable and scales with production ramp.
    const fixedRampFrac = rp > 0 ? 0.5 + 0.5 * rp : 0;
    const mpFixedCostY = gfStarted ? mpFixedCost * fixedRampFrac * cpiEsc : 0;
    const distFixedCostY = gfStarted ? distFixedCost * fixedRampFrac * cpiEsc : 0;
    const gfVarCost = mpVarCostY + distVarCostY;
    const gfFixedCostY = mpFixedCostY + distFixedCostY;
    const gfOpCost = gfVarCost + gfFixedCostY; // total non-GOES operating cost for greenfield
    const gfRev = mpRevY + distRevY;
    const gfEBITDA = gfRev - gfGOESCost - gfOpCost;
    const gfMargin = gfRev > 0 ? gfEBITDA / gfRev : 0;
    // Captive advantage for greenfield (display): tons × (market price - production cost)
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

    // Working capital — DSO/DIO/DPO derived (NWC = CCC/365 × revenue)
    const nwcPctY = nwcPctFromCCC; // structural, from cash conversion cycle
    const nwc = totalRev * nwcPctY;
    const deltaNWC = nwc - prevNWC;
    prevNWC = nwc;

    // ── Growth capex / DDTL draw-down ──
    // Deferred capital items (TX acquisition, greenfield) deploy in a specific year.
    // When they do, the DDTL draws down the corresponding LTV × capex from the committed facility.
    // The equity portion was deployed at Y0 (full equity commitment at close in PE structures).
    let capexDeploy = 0;
    if (y === txAcqDeployYear && txAcqDeployYear > 0) capexDeploy += effTxAcqPrice; // TX bolt-on closes
    if (y === gfCapexDeployYear && gfCapexDeployYear > 0) capexDeploy += effGfCapex; // GF construction begins
    if (capexDeploy > 0) {
      // Draw LTV × capex from undrawn commitment (capped at remaining commitment)
      const newDraw = Math.min(capexDeploy * ltv, totalCommitted - cumulativeDrawn);
      cumulativeDrawn += newDraw; // cumulative draw tracker (never decreases)
      debtBal += newDraw;         // immediately increases outstanding balance
    }

    // ── Maintenance capex ──
    // % of total consolidated revenue — auto-scales as business grows. This covers recurring
    // capex to maintain existing assets (not the acquisition or greenfield build, which are
    // growth capex captured in the Sources & Uses).
    const mc = totalRev * maintCapexPct;

    // D&A: default mode uses % of revenue; advanced mode computes from components
    // ASSUMPTION: 50% of maintenance capex is capitalized (in D&A), 50% is expensed.
    // Both portions are fully tax-deductible — just through different accounting paths.
    const MAINT_CAPITALIZATION_RATE = 0.50;
    let da, acqDA = 0, gfDA = 0, maintDA = 0;
    if (useAdvancedDep) {
      // Advanced: component-based depreciation schedule
      // Step-up depreciation on acquisition basis (§338(h)(10) / §754 election)
      const butlerDA = butlerAcqPrice * acqDepreciablePct / acqDepLife;
      const txAcqDA = (effTxAcqPrice > 0 && y >= txExistStartYear) ? effTxAcqPrice * acqDepreciablePct / acqDepLife : 0;
      acqDA = butlerDA + txAcqDA;
      gfDA = (effGfCapex > 0 && gfDepLife > 0 && y >= txGfStartYear) ? effGfCapex / gfDepLife : 0;
      maintDA = mc * MAINT_CAPITALIZATION_RATE;
      da = acqDA + gfDA + maintDA;
    } else {
      // Simplified: D&A as % of revenue — standard PE screening approach
      // Implicitly captures step-up, greenfield, bonus dep, and capitalized maintenance
      da = totalRev * daPctRevenue;
    }

    // ── Tax computation — two versions ──
    // Taxable income under GAAP deducts D&A (non-cash but deductible) and the expensed
    // portion of maintenance capex (routine repairs — tax-deductible in the year incurred,
    // vs. capitalized portion which creates D&A in future years).
    // We run two parallel tax computations:
    //   1. Unlevered tax (EBIT basis, no interest deduction): used for UFCF and DCF valuation
    //   2. Levered tax (EBT basis, after interest): used for LFCF and IRR computation
    const maintExpensed = mc * (1 - MAINT_CAPITALIZATION_RATE); // portion of MC expensed immediately
    // Interest = coupon on drawn balance + commitment fee on undrawn DDTL commitment
    const undrawnCommitment = Math.max(0, totalCommitted - cumulativeDrawn);
    const intAnn = debtBal * costOfDebt + undrawnCommitment * ddtlCommitmentFee;
    // EBIT = EBITDA - D&A - expensed maintenance capex (all tax-deductible non-revenue items)
    const ebit = totalEBITDA - da - maintExpensed;

    // Unlevered tax: EBIT basis (no interest deduction)
    // TCJA §172: NOL offsets up to 80% of taxable EBIT; balance carries forward indefinitely.
    let tax, nolUsedUnlevered;
    if (ebit < 0) {
      // Negative EBIT creates NOL carryforward — no tax due
      nolBalanceUnlevered += Math.abs(ebit);
      tax = 0;
      nolUsedUnlevered = 0;
    } else {
      // Use NOL to shelter up to 80% of taxable income; pay tax on the remaining 20%+
      nolUsedUnlevered = Math.min(nolBalanceUnlevered, ebit * 0.80);
      tax = Math.max(0, (ebit - nolUsedUnlevered) * taxRate);
      nolBalanceUnlevered -= nolUsedUnlevered;
    }
    // Unlevered FCF (UFCF): EBITDA - maintenance capex - unlevered taxes - change in NWC
    // (no interest, no principal — the "pure operations" cashflow for DCF valuation)
    const ufcf = totalEBITDA - mc - tax - deltaNWC;

    // ── Section 163(j) interest deductibility cap ──
    // TCJA §163(j): business interest deduction limited to interestCapPct × EBITDA
    // (default 30%). Disallowed interest carries forward indefinitely.
    // Prior-year carryforward is applied first before current-year interest.
    let deductibleInterest = intAnn;
    let disallowedInterest = 0;
    if (interestCapEnabled) {
      const maxDeductible = Math.max(0, totalEBITDA * interestCapPct);
      // Total interest available to deduct = current year + carryforward balance
      const totalInterest = intAnn + disallowedInterestBalance;
      deductibleInterest = Math.min(totalInterest, maxDeductible);
      disallowedInterest = totalInterest - deductibleInterest; // new carryforward balance
      disallowedInterestBalance = disallowedInterest;
    }

    // Levered tax: EBT basis (after deductible interest — creates the interest tax shield)
    // Same TCJA §172 80% NOL rule applies on the levered (post-interest) taxable income.
    const ebt = ebit - deductibleInterest;
    let taxLevered, nolUsed;
    if (ebt < 0) {
      // Negative EBT (typically in early years when interest cost is high): no levered tax
      nolBalance += Math.abs(ebt);
      taxLevered = 0;
      nolUsed = 0;
    } else {
      nolUsed = Math.min(nolBalance, ebt * 0.80);
      taxLevered = Math.max(0, (ebt - nolUsed) * taxRate);
      nolBalance -= nolUsed;
    }

    // ── Debt service ──
    // Mandatory amortization: debtAmortPct × BOY balance (reduces outstanding each year).
    // Cash sweep: additional voluntary paydown of cashflow above minimum cash reserve.
    // Sweep is constrained by (a) available pre-sweep FCF above minCashBalance, and
    // (b) remaining debt balance after scheduled amortization.
    const schedAmort = debtBal * debtAmortPct; // scheduled mandatory amortization
    const amort = Math.min(schedAmort, debtBal); // capped at outstanding balance
    const preSweepFCF = totalEBITDA - mc - taxLevered - intAnn - deltaNWC - amort;
    const sweepable = Math.max(0, preSweepFCF - minCashBalance); // excess above cash floor
    const sweep = cashSweepPct > 0 ? Math.min(sweepable * cashSweepPct, debtBal - amort) : 0;
    const totalPrincipal = amort + sweep;
    debtBal = Math.max(0, debtBal - totalPrincipal); // EOY balance for next year's interest calc

    // Levered FCF (LFCF): what flows to equity after ALL obligations (interest + principal + capex)
    const lfcf = totalEBITDA - mc - taxLevered - intAnn - totalPrincipal - deltaNWC;
    cumUFCF += ufcf;
    cumLFCF += lfcf;
    // Equity return metrics: cash-on-cash yield and DPI (distributions to paid-in)
    const cashOnCash = eq > 0 ? lfcf / eq : 0;
    const dpi = eq > 0 ? cumLFCF / eq : 0;
    const intCoverage = intAnn > 0 ? totalEBITDA / intAnn : null;
    const leverageRatio = totalEBITDA > 0 ? debtBal / totalEBITDA : null;
    const dscr = (intAnn + amort) > 0 ? (totalEBITDA - mc - taxLevered) / (intAnn + amort) : null;

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
      gfVarCost, gfFixedCostY, gfOpCost, learningPremium,
      gfEBITDA, gfMargin, gfCaptive, gfMarketPurchase, captiveAdvGF,
      // TX non-core
      txNCRevY, txNCEBITDA,
      // TX totals
      txTotalRev, txTotalEBITDA, txMargin, totalCaptiveAdv,
      // Consolidated
      totalRev, totalEBITDA, margin,
      capexDeploy,
      nwcPctY, nwc, deltaNWC, mc, da, acqDA, gfDA, maintDA, maintExpensed, ebit, ebt, tax, taxLevered, ufcf, lfcf, intAnn,
      debtBal, drawnBalance: debtBal, undrawnCommitment, schedAmort, amort, sweep, totalPrincipal, cumUFCF, cumLFCF, cashOnCash, dpi, intCoverage, leverageRatio, dscr,
      nolBalance, nolBalanceUnlevered, nolUsed, nolUsedUnlevered,
      deductibleInterest, disallowedInterest, disallowedInterestBalance,
      // Sourcing
      totalTXGOESDemand, desiredCaptive, marketPurchase, spare,
    });
  }

  // ── Terminal value & exit ──
  // Standard PE exit: exit multiple × terminal EBITDA × (1 - transaction costs).
  // Terminal EBITDA = Year N EBITDA (last year of hold). The exit is modeled as a
  // clean sale: terminal value net of deal costs is the enterprise value received.
  const termYear = years[holdPeriod];
  const tE = termYear.totalEBITDA;   // terminal year EBITDA (basis for exit multiple)
  const tv = tE * exitMultiple * (1 - exitTxnCosts); // net terminal value after deal fees

  // Remaining debt at exit (after all amortization + optional sweeps over hold period)
  const debtAtExit = termYear.debtBal;

  // ── IRR cashflow vectors — timing-aware ──
  // Unlevered IRR (project IRR): uses UFCF + deferred capex outflows, no interest/debt.
  // Y0 = -(y0Uses - doeGrant) — net cash out at close after DOE grant.
  // Deferred capex: TX acquisition and greenfield appear as outflows in their deploy year.
  // Terminal year adds the net terminal value (enterprise exit proceeds).
  const uCFs = years.map((yr, i) => {
    let cf = i === 0 ? -(y0Uses - doeGrantAmt) : yr.ufcf;
    if (i > 0 && i === txAcqDeployYear) cf -= effTxAcqPrice; // bolt-on purchase outflow
    if (i > 0 && i === gfCapexDeployYear) cf -= effGfCapex;  // greenfield construction outflow
    if (i === holdPeriod) cf += tv; // exit proceeds
    return cf;
  });

  // Levered IRR (equity IRR): uses LFCF, equity outflow at Y0, equity-residual at exit.
  // Y0 = -eq (equity committed at close — DDTL means full facility committed, equity invested).
  // Exit: LFCF in terminal year + (terminal value - remaining debt) = equity proceeds.
  // Deferred capex is funded from DDTL draws — NO additional equity calls mid-hold.
  const lCFs = years.map((yr, i) => i === 0 ? -eq : i === holdPeriod ? yr.lfcf + tv - debtAtExit : yr.lfcf);
  const uIRR = calculateIRR(uCFs);
  const lIRR = calculateIRR(lCFs);

  // Real IRR (inflation-adjusted): (1 + nominal) / (1 + CPI) - 1 (Fisher equation)
  const realUIRR = uIRR != null ? (1 + uIRR) / (1 + cpiRate) - 1 : null;
  const realLIRR = lIRR != null ? (1 + lIRR) / (1 + cpiRate) - 1 : null;

  // Operational IRR: hypothetical levered IRR if exit multiple = entry multiple (zero expansion).
  // Isolates value created by EBITDA growth + debt paydown from multiple re-rating.
  const tvNoExpansion = tE * entryMultiple * (1 - exitTxnCosts);
  const opLCFs = years.map((yr, i) =>
    i === 0 ? lCFs[0] :
    i === holdPeriod ? yr.lfcf + tvNoExpansion - debtAtExit :
    yr.lfcf
  );
  const opLIRR = calculateIRR(opLCFs);

  // Equity multiple (MOIC = Multiple on Invested Capital):
  // Total distributions to equity / equity invested = (sum of LFCFs + exit proceeds) / equity.
  const tDist = years.reduce((s, yr) => s + yr.lfcf, 0) + tv - debtAtExit;
  const equityMultiple = eq > 0 ? tDist / eq : 0;

  // ── Payback periods ──
  // Unlevered payback: years for cumulative timing-aware UFCFs to recover total investment.
  // Interpolated for fractional years (e.g. 6.3 years).
  let cum = 0, pb = null;
  for (let i = 0; i <= holdPeriod; i++) {
    cum += uCFs[i];
    if (cum >= 0 && pb === null && i > 0) {
      const prev = cum - uCFs[i]; // cumulative just before this year
      pb = i - 1 + (-prev) / uCFs[i]; // linear interpolation to crossing point
    }
  }

  // Levered payback: years for cumulative LFCF to recover equity invested (-eq at Y0).
  let levCum = -eq, levPayback = null;
  for (let i = 1; i <= holdPeriod; i++) {
    const prev = levCum;
    levCum += years[i].lfcf;
    if (levCum >= 0 && levPayback === null) {
      levPayback = i - 1 + (-prev) / years[i].lfcf;
    }
  }

  // DPI payback year: first year where cumulative DPI (distributions / equity paid-in) ≥ 1.0×.
  // DPI ≥ 1.0 means equity has been returned in full from operating cashflows (before exit).
  const equityPaybackYearObj = years.find(yr => yr.dpi >= 1.0);
  const equityPaybackYear = equityPaybackYearObj ? equityPaybackYearObj.year : null;

  // Covenant monitoring — check all years for breaches
  const covenantBreaches = [];
  for (let i = 1; i <= holdPeriod; i++) {
    const yr = years[i];
    const breaches = [];
    if (yr.leverageRatio != null && yr.leverageRatio > covenantMaxLeverage) {
      breaches.push(`leverage ${yr.leverageRatio.toFixed(1)}x > ${covenantMaxLeverage.toFixed(1)}x`);
    }
    if (yr.intCoverage != null && yr.intCoverage < covenantMinCoverage) {
      breaches.push(`coverage ${yr.intCoverage.toFixed(1)}x < ${covenantMinCoverage.toFixed(1)}x`);
    }
    if (yr.dscr != null && yr.dscr < covenantMinDSCR) {
      breaches.push(`DSCR ${yr.dscr.toFixed(1)}x < ${covenantMinDSCR.toFixed(1)}x`);
    }
    yr.covenantBreach = breaches.length > 0;
    yr.covenantBreaches = breaches;
    if (breaches.length > 0) covenantBreaches.push({ year: i, breaches });
  }
  // Warnings for covenant breaches
  if (covenantBreaches.length > 0) {
    const first = covenantBreaches[0];
    warnings.push(`Covenant breach in Y${first.year}: ${first.breaches.join(", ")}`);
  }
  // Legacy interest coverage warning (always active even if covenant monitoring off)
  if (!covenantMonitoring) {
    for (let i = 1; i <= holdPeriod; i++) {
      const yr = years[i];
      if (yr.intCoverage != null && yr.intCoverage < 2.0) {
        warnings.push(`Interest coverage drops below 2.0x in Year ${yr.year} (${yr.intCoverage.toFixed(1)}x) — lender covenant risk`);
        break;
      }
    }
  }

  // Debt amortization vs hold period warning
  if (holdPeriod < debtAmortYears) {
    warnings.push(`Exiting in Year ${holdPeriod} before debt fully amortizes (${debtAmortYears}yr schedule) — $${fmtM(debtAtExit)} remaining at exit.`);
  }

  // Stabilized year (first full ramp, typically Y4)
  const stab = years[Math.min(4, holdPeriod)] || years[years.length - 1];

  // ── DCF Valuation ──
  // Discounted at WACC on unlevered FCFs (UFCF). Enterprise value = PV(FCFs) + PV(TV).
  // Equity value = enterprise value - initial net debt.
  // We use debtInitial (not debtAtExit) because DCF values the enterprise as of acquisition.
  const pvFCFs = years.filter(yr => yr.year > 0).map((yr, i) => yr.ufcf / Math.pow(1 + wacc, i + 1));
  const sumPVFCFs = pvFCFs.reduce((s, v) => s + v, 0);

  // Method A: Exit Multiple — terminal value = last year EBITDA × exit multiple × (1 - deal costs)
  // (Same as the actual PE exit mechanic; consistent with IRR calculation.)
  const tvExitMult = tv;
  const pvTVExit = tvExitMult / Math.pow(1 + wacc, holdPeriod); // discounted to Y0
  const evExit = sumPVFCFs + pvTVExit;

  // Method B: Gordon Growth Model — TV = terminal UFCF × (1+g) / (WACC - g)
  // Requires WACC > terminalGrowth (otherwise denominator is ≤ 0 → infinite/undefined TV).
  // Terminal UFCF grows at terminalGrowth perpetually — consistent with GDP+inflation long-run assumption.
  const terminalUFCF = termYear.ufcf;
  const tvGordon = (wacc > terminalGrowth && terminalUFCF > 0)
    ? (terminalUFCF * (1 + terminalGrowth)) / (wacc - terminalGrowth) : 0;
  const pvTVGordon = tvGordon / Math.pow(1 + wacc, holdPeriod);
  const evGordon = sumPVFCFs + pvTVGordon;

  // Equity value = enterprise value - close-date debt (not EOY-10 — DCF reflects day-1 valuation)
  const eqValExit = evExit - debtInitial;
  const eqValGordon = evGordon - debtInitial;
  const impliedMultiple = tE > 0 ? evExit / tE : 0; // EV / terminal EBITDA

  // Backward compat aliases
  const ev = evExit;
  const pvTV = pvTVExit;
  const eqVal = eqValExit;
  const implM = impliedMultiple;

  // ── CAGRs (compound annual growth rates, entry basis → terminal year) ──
  // CAGR = (endValue/startValue)^(1/years) - 1
  // Y0 basis = entry snapshot (standalone Steel Mill at acquisition); terminal = Year N consolidated.
  const y0Rev = years[0].totalRev;
  const y0EBITDA = years[0].totalEBITDA;
  const revCAGR = (y0Rev > 0 && tE > 0) ? Math.pow(termYear.totalRev / y0Rev, 1 / holdPeriod) - 1 : null;
  const ebitdaCAGR = (y0EBITDA > 0 && tE > 0) ? Math.pow(tE / y0EBITDA, 1 / holdPeriod) - 1 : null;

  // ── Returns Attribution Waterfall ──
  // Standard PE decomposition: where did the equity return come from?
  // Three buckets (plus interim FCF distributions):
  //   1. EBITDA growth: (terminal - Y1 EBITDA) × entry multiple — value from growing earnings
  //   2. Multiple expansion: (exitMultiple - entryMultiple) × terminal EBITDA — re-rating premium
  //   3. Debt paydown: debtInitial - debtAtExit — equity value freed by deleveraging
  //   4. Cum FCF: positive operating cashflows distributed during hold (not reinvested)
  const y1EBITDA = years[1] ? years[1].totalEBITDA : y1ButlerEBITDA;
  const exitEV = tE * exitMultiple;
  const ebitdaGrowthContrib = (tE - y1EBITDA) * entryMultiple; // EBITDA delta valued at entry multiple
  const multipleContrib = (exitMultiple - entryMultiple) * tE;  // multiple expansion on terminal earnings
  const debtPaydownContrib = debtInitial - debtAtExit;           // principal repaid = equity value created
  const cumPositiveLFCF = years.reduce((s, yr) => s + Math.max(0, yr.lfcf), 0);
  const exitEquity = tv - debtAtExit + cumLFCF; // total equity proceeds: exit residual + all LFCF
  const returnsAttribution = {
    entryEquity: eq,          // equity invested at close
    exitEV,                   // gross enterprise value at exit
    ebitdaGrowthContrib,      // $M: EBITDA growth contribution (at entry multiple)
    multipleContrib,          // $M: multiple re-rating contribution
    debtPaydownContrib,       // $M: debt reduction contribution
    cumFCF: cumPositiveLFCF,  // $M: cumulative positive operating cashflow
    exitEquity,               // $M: total equity value at exit
  };

  // ── GP/LP Economics (European waterfall) ──
  // European waterfall = all capital returned before carry is paid (vs. American = deal-by-deal).
  // Waterfall order:
  //   1. Return of LP capital (eq)
  //   2. Preferred return (lpPreferredReturn = eq × ((1+hurdle)^n - 1)) — compound hurdle
  //   3. Carried interest = carryPct × profit above preferred
  //   4. Management fees deducted before carry computation
  // Management option pool (mgmtEquityPct) dilutes total distributions — simulates option grants
  // that flow to management team before GP/LP split.
  const { mgmtFee, carryPct, preferredReturn, mgmtEquityPct } = p;
  const totalMgmtFees = mgmtFee * eq * holdPeriod; // annual fee × committed equity × years
  const totalDistributions = tDist; // total equity distributions (LFCF + exit proceeds - debt)
  const mgmtDilution = totalDistributions * mgmtEquityPct; // management option carve-out
  const netDistributions = totalDistributions - mgmtDilution;
  // Compound preferred return: LP earns hurdle on contributed equity before GP gets carry
  const lpPreferredReturn = eq * (Math.pow(1 + preferredReturn, holdPeriod) - 1);
  // Profit above preferred = amount available for carry (after returning equity + preferred + fees)
  const profitAbovePreferred = Math.max(0, netDistributions - totalMgmtFees - eq - lpPreferredReturn);
  const carry = profitAbovePreferred * carryPct; // GP carried interest (typically 20%)
  const netToLP = netDistributions - totalMgmtFees - carry; // LP net proceeds
  const netLPMOIC = eq > 0 ? netToLP / eq : 0;
  // Net LP IRR: simplified (all fees/carry deducted at exit, LP sees -eq at Y0 and netToLP at exit)
  const lpCFs = years.map((_, i) => i === 0 ? -eq : i === holdPeriod ? netToLP : 0);
  const netLPIRR = calculateIRR(lpCFs);
  const gpLp = {
    totalFees: totalMgmtFees, // total management fees over hold period
    carry,                    // GP carried interest ($M)
    netToLP,                  // LP net proceeds ($M)
    netLPMOIC,                // LP net MOIC after fees and carry
    netLPIRR,                 // LP net IRR after fees and carry
    mgmtDilution,             // management option pool dilution ($M)
  };

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
    uIRR, lIRR, realUIRR, realLIRR, opLIRR,
    equityMultiple, paybackPeriod: pb, levPayback, equityPaybackYear,

    // ── Additional model outputs ──
    stab, butlerAcqPrice, txAcqPrice: effTxAcqPrice,
    totalUses, y0Uses, doeGrantAmt, txnFeesAmt,
    txAcqDeployYear, gfCapexDeployYear, uCFs,
    y1ButlerEBITDA, y1EBITDAFloored, y1EBITDAActual, tv, exitTxnCosts, chart, warnings,
    greenfieldCapex: effGfCapex, workingCapital, pensionLiability, covenantBreaches, covenantMonitoring,
    wcDSO, wcDIO, wcDPO, ccc, nwcPctFromCCC,
    goesStartUtil, goesTargetUtil, goesRampYears,
    revCAGR, ebitdaCAGR,
    goesPrice, duopolyImpact, goesPostDuopolyPrice,
    txBaseGOESDemand,

    // ── Returns Attribution ──
    returnsAttribution,

    // ── GP/LP Economics ──
    gpLp,

    // ── Backward compat aliases (used by existing UI components) ──
    ti, debt: debtInitial, eq, eqM: equityMultiple, pb, tE, termUFCF: terminalUFCF,
    ev, eqVal, pvTV, implM, intAnn: years[1] ? years[1].intAnn : 0,
    acqPrice: butlerAcqPrice, waccRate: wacc, tvDCF: tvGordon,
  };
}

/**
 * zeroYear — creates a blank Year-0 entry object with all numeric output keys set to 0.
 * Used as the Y0 entry basis placeholder in the years[] array. Year 0 is not a projection
 * year — it represents the normalized snapshot at acquisition (starting utilization, pre-duopoly
 * pricing, no TX segment yet). The caller fills in the relevant fields after calling zeroYear().
 * All keys in the returned object match the shape of operating year objects (so UI components
 * can iterate consistently from Y0 through YN without type guards).
 */
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
    "gfVarCost", "gfFixedCostY", "gfOpCost", "learningPremium",
    "gfEBITDA", "gfMargin", "gfCaptive", "gfMarketPurchase", "captiveAdvGF",
    "txNCRevY", "txNCEBITDA",
    "txTotalRev", "txTotalEBITDA", "txMargin", "totalCaptiveAdv",
    "totalRev", "totalEBITDA", "margin",
    "capexDeploy",
    "nwcPctY", "nwc", "deltaNWC", "mc", "da", "acqDA", "gfDA", "maintDA", "maintExpensed", "ebit", "ebt", "tax", "taxLevered", "ufcf", "lfcf", "intAnn",
    "debtBal", "drawnBalance", "undrawnCommitment", "amort", "sweep", "totalPrincipal", "cumUFCF", "cumLFCF", "cashOnCash", "dpi", "intCoverage",
    "totalTXGOESDemand", "desiredCaptive", "marketPurchase", "spare",
    "nolBalance", "nolBalanceUnlevered", "nolUsed", "nolUsedUnlevered",
    "deductibleInterest", "disallowedInterest", "disallowedInterestBalance",
    "schedAmort", "leverageRatio", "dscr",
  ];
  for (const k of numKeys) z[k] = 0;
  return z;
}

/**
 * strip — removes UI-only metadata from a preset/scenario object before passing to runModel().
 * Preset objects stored in the instance (DEFAULTS, user customs) carry `label` (display name)
 * and `custom` (boolean flag for custom presets) fields. runModel() doesn't know these keys —
 * stripping them avoids accidental shadowing if modelEngine ever adds those as input names.
 * @param {Object} obj - Preset object (may have label/custom fields)
 * @returns {Object} Clean inputs object suitable for runModel()
 */
export function strip(obj) {
  if (!obj) return {};
  const { label: _L, custom: _C, ...rest } = obj;
  return rest;
}
