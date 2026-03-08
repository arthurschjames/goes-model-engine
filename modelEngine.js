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
export const OVERHEAD_BASE = 30; // $M — legacy constant, now an input (overheadBase)
export const FIXED_COST_SHARE = 0.35; // ~35% of production cost is fixed (labor, maintenance, facility)
export const TAX_RATE = 0.25;
export const DOE_GRANT_AMOUNT = 75; // $M
export const INTERNALIZE_FACTOR = 0.40;
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
  doeOn: false, doeYear: 2, doeGrant: true,
  goesPriceInflation: 0.025,
  overheadBase: 45,
  nonGoesRevenue: 120, nonGoesMargin: 0.15,
  // TX Existing Business
  txExistEnabled: true,
  txBaseRevenue: 0, txBaseEBITDAMargin: 0.22, txBaseGOESDemand: 0,
  txAcqPrice: 0, txAcqNonCoreRevenue: 0, txAcqNonCoreMargin: 0.15,
  // TX Greenfield
  txGreenfieldEnabled: true,
  mpUnits: 300, goesPerMP: 14, mpASP: 900000,
  mpOpCostPct: 0.56, mpIntermediatePct: 0.12,
  distUnits: 0, goesPerDist: 0.8, distASP: 22000,
  distOpCostPct: 0.61, distIntermediatePct: 0.08,
  ramp: [0, 0.30, 0.70, 1.0], greenfieldCapex: 225, internalizeIntermediate: false,
  // TX GOES Sourcing
  captivePct: 1.00,
  // TX Non-Core
  txNonCoreRevenue: 0, txNonCoreMargin: 0.20,
  // Capital Structure
  entryMultiple: 8.0, workingCapital: 100, pensionLiability: 0, txnFees: 0.02,
  ltv: 0.60, costOfDebt: 0.07,
  // Returns
  exitMultiple: 12, holdPeriod: 10, waccRate: 0.09, waccMode: "buildup",
  // Growth & Inflation
  cpiRate: 0.025, txPriceEscalation: 0.04, nonGoesEscalation: 0.02, terminalGrowth: 0.025,
  // WACC Build-up
  riskFreeRate: 0.0405, equityRiskPremium: 0.055, beta: 1.20, sizePremium: 0.02,
  // Working Capital
  nwcPctRevenue: 0.15, // NWC as % of revenue — delta flows through FCF each year
  // Debt Structure
  debtAmortYears: 7, // Amortizing term loan — 0 = interest-only bullet
  cashSweepPct: 0, // % of excess FCF applied to mandatory debt repayment
  // Sustaining Capex
  millMaintCapex: 40, txMaintCapex: 15,
  // Depreciation — step-up basis from acquisition
  acqDepreciablePct: 0.80, // % of acquisition price allocated to depreciable assets (PP&E + goodwill/intangibles; excludes land ~5%, NWC modeled separately)
  acqDepLife: 15, // Blended straight-line life (PP&E 10-20yr, goodwill/intangibles 15yr per §197)
  gfDepLife: 20, // Greenfield plant depreciation life
};

// Scenario overrides (only values that differ from BASE)
const OVERRIDES = {
  base: { label: "Base Case" },
  bear: {
    label: "Bear Case",
    goesStartUtil: 0.60, goesTargetUtil: 0.80, goesRampYears: 5,
    goesPrice: 5000, duopolyImpact: 0.22,
    goesProductionCost: 3200, goesPriceInflation: 0.01, nipponYear: 4, dodRenewal: false, doeYear: 3,
    overheadBase: 55,
    nonGoesRevenue: 100, nonGoesMargin: 0.12,
    mpUnits: 150, mpASP: 700000, goesPerMP: 16,
    mpOpCostPct: 0.62, mpIntermediatePct: 0.14,
    distASP: 18000, goesPerDist: 0.9,
    distOpCostPct: 0.67, distIntermediatePct: 0.10,
    ramp: [0, 0.25, 0.60, 0.90], greenfieldCapex: 275,
    entryMultiple: 9.0, workingCapital: 110, pensionLiability: 400,
    nwcPctRevenue: 0.18,
    doeGrant: false, ltv: 0.45, costOfDebt: 0.08,
    exitMultiple: 9, waccRate: 0.10,
    cpiRate: 0.035, txPriceEscalation: 0.02, nonGoesEscalation: 0.015, terminalGrowth: 0.02,
    riskFreeRate: 0.045, beta: 1.35, sizePremium: 0.025,
    millMaintCapex: 50,
  },
  bull: {
    label: "Bull Case",
    goesStartUtil: 0.85, goesTargetUtil: 0.95, goesRampYears: 1,
    goesPrice: 6500, duopolyImpact: 0.12,
    goesProductionCost: 2400, goesPriceInflation: 0.04, nipponYear: 7, doeOn: true, doeYear: 2,
    overheadBase: 35,
    nonGoesRevenue: 150, nonGoesMargin: 0.18,
    mpUnits: 450, mpASP: 1100000, goesPerMP: 12,
    mpOpCostPct: 0.50, mpIntermediatePct: 0.10,
    distUnits: 2000, distASP: 28000, goesPerDist: 0.6,
    distOpCostPct: 0.52, distIntermediatePct: 0.06,
    greenfieldCapex: 375, internalizeIntermediate: true,
    txNonCoreRevenue: 50, txNonCoreMargin: 0.25,
    entryMultiple: 7.0, nwcPctRevenue: 0.12, ltv: 0.60, costOfDebt: 0.065,
    exitMultiple: 16, waccRate: 0.085,
    cpiRate: 0.020, txPriceEscalation: 0.06, nonGoesEscalation: 0.025, terminalGrowth: 0.03,
    riskFreeRate: 0.035, beta: 1.05, sizePremium: 0.015,
    millMaintCapex: 35, txMaintCapex: 20,
  },
  goesOnly: {
    label: "GOES Only",
    txExistEnabled: false, txGreenfieldEnabled: false,
    mpUnits: 0, distUnits: 0, greenfieldCapex: 0, captivePct: 0,
    txNonCoreRevenue: 0, txMaintCapex: 0,
    workingCapital: 75, doeGrant: false, ltv: 0.50,
    exitMultiple: 10, waccRate: 0.10,
  },
  vtc: {
    label: "VTC Acquisition",
    goesStartUtil: 0.67, goesTargetUtil: 0.95, goesRampYears: 3, doeOn: true, doeYear: 2,
    txBaseRevenue: 4000, txBaseEBITDAMargin: 0.25, txBaseGOESDemand: 40000,
    txAcqPrice: 3500, txAcqNonCoreRevenue: 200, txAcqNonCoreMargin: 0.15,
    mpUnits: 0, distUnits: 0, greenfieldCapex: 0,
    workingCapital: 200, exitMultiple: 14, txMaintCapex: 60,
  },
  deltaStar: {
    label: "Delta Star",
    goesStartUtil: 0.65, goesTargetUtil: 0.88, goesRampYears: 3,
    txBaseRevenue: 300, txBaseEBITDAMargin: 0.22, txBaseGOESDemand: 5000,
    txAcqPrice: 500, txAcqNonCoreRevenue: 25, txAcqNonCoreMargin: 0.20,
    mpUnits: 150, greenfieldCapex: 175,
    exitMultiple: 13, txMaintCapex: 20,
  },
};

// Build DEFAULTS from BASE + OVERRIDES
export const DEFAULTS = {};
for (const [key, over] of Object.entries(OVERRIDES)) {
  DEFAULTS[key] = { ...BASE, ...over };
}

export const SCENARIO_KEYS = ["bear", "base", "bull", "goesOnly", "vtc", "deltaStar"];
export const SCENARIO_LABELS = {
  bear: "Bear Case", base: "Base Case", bull: "Bull Case",
  goesOnly: "GOES Only", vtc: "VTC Acquisition", deltaStar: "Delta Star",
};

// ─── Scenario Blending ──────────────────────────────────────────────────────
// Bear/Bull "dot" values represent the full extreme assumption for each input.
// When loading Bear or Bull, we blend each numeric input 50% toward Base so
// the scenario reflects a weighted view rather than every variable at its worst/best.
// Base case always loads at its exact dot values (no blending).
const BLEND_WEIGHT = 0.50; // fraction toward base (0 = full extreme, 1 = pure base)

// Keys that should NOT be blended (booleans, enums, arrays, labels)
const NO_BLEND_KEYS = new Set([
  "label", "custom", "dodOn", "dodRenewal", "doeOn", "doeGrant",
  "internalizeIntermediate", "txExistEnabled", "txGreenfieldEnabled",
  "ramp", "waccMode",
]);

export function blendScenario(scenarioKey) {
  const full = DEFAULTS[scenarioKey];
  if (!full) return null;
  // Base and non-bear/bull scenarios load at exact values
  if (scenarioKey !== "bear" && scenarioKey !== "bull") return { ...full };
  const base = DEFAULTS.base;
  const blended = {};
  for (const k of Object.keys(full)) {
    if (NO_BLEND_KEYS.has(k)) {
      blended[k] = full[k];
    } else if (typeof full[k] === "number" && typeof base[k] === "number") {
      // Blend: full + BLEND_WEIGHT * (base - full) = lerp(full, base, BLEND_WEIGHT)
      blended[k] = full[k] + BLEND_WEIGHT * (base[k] - full[k]);
    } else {
      blended[k] = full[k];
    }
  }
  return blended;
}

// ─── Slider Reference Markers (bear/base/bull) ─────────────────────────────
export const MARKERS = {
  overheadBase: { bear: 55, base: 45, bull: 35 },
  goesStartUtil: { bear: 0.60, base: 0.70, bull: 0.85 },
  goesTargetUtil: { bear: 0.80, base: 0.92, bull: 0.95 },
  goesRampYears: { bear: 5, base: 2, bull: 1 },
  goesPrice: { bear: 5000, base: 5600, bull: 6500 },
  duopolyImpact: { bear: 0.22, base: 0.17, bull: 0.12 },
  goesProductionCost: { bear: 3200, base: 2800, bull: 2400 },
  nipponYear: { bear: 4, base: 5, bull: 7 },
  doeYear: { bear: 3, base: 2, bull: 2 },
  nonGoesRevenue: { bear: 100, base: 120, bull: 150 },
  nonGoesMargin: { bear: 0.12, base: 0.15, bull: 0.18 },
  mpUnits: { bear: 150, base: 300, bull: 450 },
  goesPerMP: { bear: 16, base: 14, bull: 12 },
  mpASP: { bear: 700000, base: 900000, bull: 1100000 },
  mpOpCostPct: { bear: 0.62, base: 0.56, bull: 0.50 },
  distUnits: { bear: 0, base: 0, bull: 2000 },
  distASP: { bear: 18000, base: 22000, bull: 28000 },
  distOpCostPct: { bear: 0.67, base: 0.61, bull: 0.52 },
  captivePct: { bear: 0.50, base: 1.00, bull: 1.00 },
  entryMultiple: { bear: 9, base: 8, bull: 7 },
  greenfieldCapex: { bear: 275, base: 225, bull: 175 },
  ltv: { bear: 0.45, base: 0.60, bull: 0.60 },
  costOfDebt: { bear: 0.08, base: 0.07, bull: 0.065 },
  exitMultiple: { bear: 9, base: 12, bull: 16 },
  holdPeriod: { bear: 12, base: 10, bull: 7 },
  millMaintCapex: { bear: 50, base: 40, bull: 35 },
  txMaintCapex: { bear: 20, base: 15, bull: 10 },
  pensionLiability: { bear: 400, base: 0, bull: 0 },
  cpiRate: { bear: 0.035, base: 0.025, bull: 0.020 },
  txPriceEscalation: { bear: 0.02, base: 0.04, bull: 0.06 },
  nonGoesEscalation: { bear: 0.015, base: 0.02, bull: 0.025 },
  terminalGrowth: { bear: 0.02, base: 0.025, bull: 0.03 },
  riskFreeRate: { bear: 0.045, base: 0.0405, bull: 0.035 },
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
 *   TX Existing (txBaseRevenue, txBaseEBITDAMargin, ...), TX Greenfield (mpUnits,
 *   mpASP, ...), Capital Structure (entryMultiple, ltv, ...), Growth/Inflation
 *   (cpiRate, txPriceEscalation, ...), Returns (exitMultiple, holdPeriod, waccRate).
 *   See BASE object above for all ~60 parameters and their defaults.
 *
 * @returns {Object} Full model output:
 *   - years[]: Array of year-by-year projections (production, revenue, EBITDA, FCF, debt, etc.)
 *   - stab: Stabilized-year snapshot (last year metrics)
 *   - uIRR/lIRR: Unlevered/levered IRR (decimal, e.g. 0.15 = 15%)
 *   - realUIRR/realLIRR: Inflation-adjusted real IRRs
 *   - eqM: Equity MOIC
 *   - ev: DCF enterprise value ($M)
 *   - implM: DCF implied exit multiple
 *   - pb: Payback period (years, null if >hold)
 *   - tv: Terminal value, ti: Total investment
 *   - millAcqPrice, txAcqPrice: Acquisition prices ($M)
 *   - warnings[]: Array of warning strings for edge cases
 */
export function runModel(inputs) {
  const p = { ...BASE, ...inputs };
  const {
    goesProductionCost,
    nipponYear, dodOn, dodRenewal, doeOn, doeYear, doeGrant,
    goesPriceInflation, overheadBase,
    nonGoesRevenue, nonGoesMargin,
    txExistEnabled, txBaseRevenue, txBaseEBITDAMargin, txBaseGOESDemand,
    txAcqPrice, txAcqNonCoreRevenue, txAcqNonCoreMargin,
    txGreenfieldEnabled,
    mpUnits, goesPerMP, mpASP,
    mpOpCostPct, mpIntermediatePct,
    distUnits, goesPerDist, distASP,
    distOpCostPct, distIntermediatePct,
    ramp, greenfieldCapex, internalizeIntermediate,
    captivePct, txNonCoreRevenue, txNonCoreMargin,
    entryMultiple, workingCapital, pensionLiability, txnFees,
    ltv, costOfDebt,
    exitMultiple, holdPeriod, waccMode, waccRate,
    cpiRate, txPriceEscalation, nonGoesEscalation, terminalGrowth,
    riskFreeRate, equityRiskPremium, beta, sizePremium,
    nwcPctRevenue, debtAmortYears, cashSweepPct, millMaintCapex, txMaintCapex,
    acqDepreciablePct, acqDepLife, gfDepLife,
  } = p;

  const goesStartUtil = p.goesStartUtil ?? BASE.goesStartUtil;
  const goesTargetUtil = p.goesTargetUtil ?? goesStartUtil;
  const goesRampYears = p.goesRampYears ?? BASE.goesRampYears;

  const goesPrice = p.goesPrice ?? BASE.goesPrice;
  const duopolyImpact = p.duopolyImpact ?? BASE.duopolyImpact;
  const goesPostDuopolyPrice = goesPrice * (1 - duopolyImpact);

  // Operating cost with internalize savings
  const mpIntermSavings = internalizeIntermediate ? mpIntermediatePct * (1 - INTERNALIZE_FACTOR) : 0;
  const distIntermSavings = internalizeIntermediate ? distIntermediatePct * (1 - INTERNALIZE_FACTOR) : 0;
  const mpEffOpCostPct = mpOpCostPct - mpIntermSavings;
  const distEffOpCostPct = distOpCostPct - distIntermSavings;

  // Effective TX segment enables
  const txExistActive = txExistEnabled !== false && txBaseRevenue > 0;
  const txGfActive = txGreenfieldEnabled !== false;

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
  // Uses post-duopoly price to normalize for known duopoly compression,
  // so that raising the forward pre-duopoly price assumption improves IRR
  // (more revenue) without also inflating the acquisition cost.
  // Y1 EBITDA uses starting utilization (current operations) for entry valuation
  const y1DoeBlend = doeOn ? Math.min(1, Math.max(0, (1 - doeYear + 1) / DOE_RAMP_YEARS)) : 0;
  const y1Prod = NAMEPLATE * goesStartUtil;
  // At starting utilization, effective cost = goesProductionCost (no adjustment).
  const y1PC = goesProductionCost - (DOE_SAVINGS_PER_TON * y1DoeBlend);
  const y1MP = goesPostDuopolyPrice; // Entry valuation normalizes to post-duopoly
  const y1DodT = dodOn ? DOD_TONS : 0;
  const y1TPT = Math.max(0, y1Prod - y1DodT);
  const y1GoesRev = (y1TPT * y1MP + y1DodT * DOD_PRICE) / 1e6;
  const y1GoesCOGS = (y1Prod * y1PC) / 1e6;
  const y1GoesGP = y1GoesRev - y1GoesCOGS;
  const y1NonGoesGP = nonGoesRevenue * nonGoesMargin;
  const y1Steel MillEBITDA = y1GoesGP + y1NonGoesGP - overheadBase;

  // ── Sources & Uses ── (TX acq/capex zeroed if segment disabled)
  const millAcqPrice = Math.round(entryMultiple * Math.max(y1Steel MillEBITDA, 50));
  const effTxAcqPrice = txExistActive ? txAcqPrice : 0;
  const effGfCapex = txGfActive ? greenfieldCapex : 0;
  const txnFeesAmt = (millAcqPrice + effTxAcqPrice) * txnFees;
  const totalUses = millAcqPrice + effTxAcqPrice + effGfCapex + workingCapital + pensionLiability + txnFeesAmt;
  const doeGrantAmt = (doeOn && doeGrant) ? DOE_GRANT_AMOUNT : 0;
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
  if (exitMultiple < entryMultiple * 0.5) warnings.push("Exit multiple is less than half the entry multiple — likely negative returns.");
  if (wacc <= terminalGrowth) warnings.push("WACC ≤ terminal growth — Gordon Growth terminal value is undefined.");

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

    // Ramp
    const ri = Math.min(y - 1, ramp.length - 1);
    const rp = ri < 0 ? 0 : ramp[ri];

    // Escalation factors: Y1=base, Y2=base*(1+r), etc.
    const cpiEsc = Math.pow(1 + cpiRate, y - 1);
    const txPriceEsc = Math.pow(1 + txPriceEscalation, y - 1);
    const nonGoesEsc = Math.pow(1 + nonGoesEscalation, y - 1);

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

    // TX GOES demand (respects enable toggles)
    const mpUnitsY = txGfActive ? mpUnits * rp : 0;
    const distUnitsY = txGfActive ? distUnits * rp : 0;
    const gfGOESDemand = mpUnitsY * goesPerMP + distUnitsY * goesPerDist;
    const existGOESDemand = txExistActive ? txBaseGOESDemand : 0;
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

    // GOES segment EBITDA
    const overheadY = overheadBase * cpiEsc;
    const goesEBITDA = goesGP + nonGoesGP - overheadY;
    const goesSegRev = goesExtRev + nonGoesRevY;
    const goesMargin = goesSegRev > 0 ? goesEBITDA / goesSegRev : 0;

    // ── TX Existing Business ── (zeroed if disabled)
    const txExistRevY = txExistActive ? txBaseRevenue * txPriceEsc : 0;
    const txExistEBITDA_pre = txExistRevY * txBaseEBITDAMargin;
    // Captive advantage: proportional allocation
    const existFrac = totalTXGOESDemand > 0 ? existGOESDemand / totalTXGOESDemand : 0;
    const existCaptive = actualCaptive * existFrac;
    const captiveAdvExist = existCaptive * (mktPrice - prodCost) / 1e6;
    const adjExistEBITDA = txExistEBITDA_pre + captiveAdvExist;
    // Existing non-core
    const txAcqNCRevY = txExistActive ? txAcqNonCoreRevenue * txPriceEsc : 0;
    const txAcqNCEBITDA = txAcqNCRevY * txAcqNonCoreMargin;

    // ── TX Greenfield ── (zeroed if disabled)
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

    // ── TX Non-Core (Greenfield) ──
    const txNCRevY = txGfActive ? txNonCoreRevenue * rp * txPriceEsc : 0;
    const txNCEBITDA = txNCRevY * txNonCoreMargin;

    // ── TX Segment Totals ──
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
    const mc = (millMaintCapex + txMaintCapex) * cpiEsc;
    // D&A: step-up depreciation on acquisition basis + greenfield capex + maintenance
    const acqDA = (millAcqPrice + effTxAcqPrice) * acqDepreciablePct / acqDepLife;
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

  // Equity multiple
  const tDist = years.reduce((s, yr) => s + yr.lfcf, 0) + tv - debtAtExit;
  const eqM = eq > 0 ? tDist / eq : 0;

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

  // ── DCF ──
  // Method A: Exit Multiple
  const tvExitMult = tE * exitMultiple;
  const pvFCFs = years.filter(yr => yr.year > 0).map((yr, i) => yr.ufcf / Math.pow(1 + wacc, i + 1));
  const pvTVExit = tvExitMult / Math.pow(1 + wacc, holdPeriod);
  const evExit = pvFCFs.reduce((s, v) => s + v, 0) + pvTVExit;

  // Method B: Gordon Growth
  const termUFCF = termYear.ufcf;
  const tvGordon = (wacc > terminalGrowth && termUFCF > 0)
    ? (termUFCF * (1 + terminalGrowth)) / (wacc - terminalGrowth) : 0;
  const pvTVGordon = tvGordon / Math.pow(1 + wacc, holdPeriod);
  const evGordon = pvFCFs.reduce((s, v) => s + v, 0) + pvTVGordon;

  // Primary DCF uses exit multiple method (for backward compat)
  const ev = evExit;
  const pvTV = pvTVExit;
  const eqVal = ev - debtInitial;
  const implM = tE > 0 ? ev / tE : 0;

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
    years, stab, ti, millAcqPrice, txAcqPrice: effTxAcqPrice,
    debt: debtInitial, debtAtExit, eq, intAnn: debtInitial * costOfDebt,
    totalUses, doeGrantAmt, txnFeesAmt,
    y1Steel MillEBITDA, uIRR, lIRR, realUIRR, realLIRR,
    eqM, pb, tv, tE, chart,
    ev, eqVal, pvTV, pvFCFs, pvTVGordon, tvGordon, evGordon,
    tvExitMult, implM, wacc, ke, kdAfterTax, termUFCF,
    greenfieldCapex: effGfCapex, workingCapital, pensionLiability, goesStartUtil, goesTargetUtil, goesRampYears,
    goesPrice, duopolyImpact, goesPostDuopolyPrice,
    warnings,
    // Backward compat aliases
    acqPrice: millAcqPrice, waccRate: wacc, tvDCF: tvGordon,
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
