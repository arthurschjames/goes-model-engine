// ─── Monte Carlo Simulation Engine ─────────────────────────────────────────
// Pure JS — no React, no DOM. Designed to run in a Web Worker.
// Provides distribution sampling, simulation orchestration, and statistical analysis.

// ─── Random Sampling ───────────────────────────────────────────────────────

/** Triangular distribution: min, mode, max */
function sampleTriangular(min, mode, max) {
  const u = Math.random();
  const fc = (mode - min) / (max - min);
  if (u < fc) return min + Math.sqrt(u * (max - min) * (mode - min));
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

/** Uniform distribution: min, max */
function sampleUniform(min, max) {
  return min + Math.random() * (max - min);
}

/** Discrete uniform: min, max (inclusive integers) */
function sampleDiscreteUniform(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

/** Sample from a variable config */
function sampleVariable(config) {
  const { distribution, min, max, mode } = config;
  if (distribution === "triangular") return sampleTriangular(min, mode, max);
  if (distribution === "discrete_uniform") return sampleDiscreteUniform(min, max);
  return sampleUniform(min, max);
}

// ─── Default Monte Carlo Variable Configurations ───────────────────────────

export const MC_DEFAULTS = {
  goesPrice: {
    label: "GOES Market Price",
    key: "goesPrice",
    distribution: "triangular",
    min: 4200, mode: 5600, max: 6500,
    format: "dollar",
  },
  goesProductionCost: {
    label: "Production Cost",
    key: "goesProductionCost",
    distribution: "triangular",
    min: 2400, mode: 2800, max: 3200,
    format: "dollar",
  },
  goesStartUtil: {
    label: "Utilization Rate",
    key: "goesStartUtil",
    distribution: "uniform",
    min: 0.60, max: 0.95,
    format: "pct",
  },
  entryMultiple: {
    label: "Entry Multiple",
    key: "entryMultiple",
    distribution: "triangular",
    min: 6.0, mode: 8.0, max: 10.0,
    format: "x",
  },
  exitMultiple: {
    label: "Exit Multiple",
    key: "exitMultiple",
    distribution: "triangular",
    min: 10.0, mode: 12.0, max: 14.0,
    format: "x",
  },
  nipponYear: {
    label: "Duopoly Timing",
    key: "nipponYear",
    distribution: "discrete_uniform",
    min: 4, max: 8,
    format: "years",
  },
  duopolyImpact: {
    label: "Duopoly Price Impact",
    key: "duopolyImpact",
    distribution: "uniform",
    min: 0.08, max: 0.30,
    format: "pct",
  },
  greenfieldCapex: {
    label: "Greenfield Capex",
    key: "greenfieldCapex",
    distribution: "triangular",
    min: 175, mode: 225, max: 275,
    format: "dollarM",
  },
};

export const MC_VARIABLE_KEYS = Object.keys(MC_DEFAULTS);

// ─── Spearman Rank Correlation ─────────────────────────────────────────────

function rankArray(arr) {
  const indexed = arr.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => a.v - b.v);
  const ranks = new Array(arr.length);
  for (let i = 0; i < indexed.length; i++) {
    ranks[indexed[i].i] = i + 1;
  }
  return ranks;
}

function spearmanCorrelation(x, y) {
  const n = x.length;
  if (n < 3) return 0;
  const rx = rankArray(x);
  const ry = rankArray(y);
  let sumD2 = 0;
  for (let i = 0; i < n; i++) {
    const d = rx[i] - ry[i];
    sumD2 += d * d;
  }
  return 1 - (6 * sumD2) / (n * (n * n - 1));
}

// ─── Percentile Calculation ────────────────────────────────────────────────

function percentile(sorted, p) {
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ─── Run Monte Carlo Simulation ────────────────────────────────────────────
/**
 * Run N iterations of the financial model with randomized inputs.
 * Called from Web Worker (monteCarloWorker.js) to avoid blocking the UI.
 *
 * @param {Function} runModel - The model engine's runModel(inputs) function
 * @param {Object} baseInputs - Base scenario inputs (non-randomized values used as defaults)
 * @param {Array<{key: string, distribution: string, min: number, max: number, mode?: number}>} variableConfigs
 *   Array of enabled MC variable configs — each specifies distribution type and range
 * @param {number} [n=1000] - Number of iterations to run
 * @param {Function|null} [onProgress] - Optional callback(done, total) called every 50 iterations
 * @returns {{stats: Object, results: Array, correlations: Array}} Simulation results:
 *   stats.irr/moic: {mean, p10, p25, p50, p75, p90} percentile breakdowns
 *   stats.probabilities: P(IRR >= threshold) for common thresholds
 *   correlations: Spearman rank correlations between each variable and IRR
 */
export function runMonteCarlo(runModel, baseInputs, variableConfigs, n = 1000, onProgress = null) {
  const results = [];
  const sampledInputs = {}; // key -> array of sampled values

  // Initialize sampled input arrays
  for (const cfg of variableConfigs) {
    sampledInputs[cfg.key] = [];
  }

  for (let i = 0; i < n; i++) {
    // Generate randomized inputs
    const iterInputs = { ...baseInputs };
    for (const cfg of variableConfigs) {
      const val = sampleVariable(cfg);
      iterInputs[cfg.key] = val;
      sampledInputs[cfg.key].push(val);
    }

    // Run model
    const calc = runModel(iterInputs);

    results.push({
      uIRR: calc.uIRR,
      lIRR: calc.lIRR,
      eqM: calc.eqM,
      ev: calc.ev,
      pb: calc.pb,
      totalEBITDA: calc.stab.totalEBITDA,
      nipponYear: iterInputs.nipponYear,
      goesPrice: iterInputs.goesPrice,
    });

    // Progress callback every 50 iterations
    if (onProgress && (i + 1) % 50 === 0) {
      onProgress(i + 1, n);
    }
  }

  // ── Compute statistics ──
  const validIRR = results.filter(r => r.uIRR != null);
  const irrs = validIRR.map(r => r.uIRR).sort((a, b) => a - b);
  const moics = results.map(r => r.eqM).sort((a, b) => a - b);

  const stats = {
    n,
    validCount: validIRR.length,
    invalidCount: n - validIRR.length,
    irr: {
      p10: percentile(irrs, 10),
      p25: percentile(irrs, 25),
      p50: percentile(irrs, 50),
      p75: percentile(irrs, 75),
      p90: percentile(irrs, 90),
      mean: irrs.reduce((s, v) => s + v, 0) / irrs.length,
      min: irrs[0],
      max: irrs[irrs.length - 1],
    },
    moic: {
      p10: percentile(moics, 10),
      p25: percentile(moics, 25),
      p50: percentile(moics, 50),
      p75: percentile(moics, 75),
      p90: percentile(moics, 90),
      mean: moics.reduce((s, v) => s + v, 0) / moics.length,
    },
  };

  // ── Probability of meeting thresholds ──
  stats.probIRR = (threshold) => {
    const count = irrs.filter(v => v >= threshold).length;
    return count / irrs.length;
  };

  // ── Build IRR histogram ──
  const binCount = 30;
  const irrMin = irrs[0];
  const irrMax = irrs[irrs.length - 1];
  const irrRange = irrMax - irrMin || 0.01;
  const binWidth = irrRange / binCount;
  const histogram = [];
  for (let b = 0; b < binCount; b++) {
    const lo = irrMin + b * binWidth;
    const hi = lo + binWidth;
    const count = irrs.filter(v => v >= lo && (b === binCount - 1 ? v <= hi : v < hi)).length;
    histogram.push({
      binLo: lo,
      binHi: hi,
      binMid: (lo + hi) / 2,
      count,
      frequency: count / irrs.length,
    });
  }

  // ── Build MOIC histogram ──
  const moicMin = moics[0];
  const moicMax = moics[moics.length - 1];
  const moicRange = moicMax - moicMin || 0.1;
  const moicBinWidth = moicRange / 20;
  const moicHistogram = [];
  for (let b = 0; b < 20; b++) {
    const lo = moicMin + b * moicBinWidth;
    const hi = lo + moicBinWidth;
    const count = moics.filter(v => v >= lo && (b === 19 ? v <= hi : v < hi)).length;
    moicHistogram.push({
      binLo: lo, binHi: hi, binMid: (lo + hi) / 2,
      count, frequency: count / moics.length,
    });
  }

  // ── Sensitivity ranking (Spearman correlation with IRR) ──
  const irrArray = results.map(r => r.uIRR ?? 0);
  const sensitivity = [];
  for (const cfg of variableConfigs) {
    const corr = spearmanCorrelation(sampledInputs[cfg.key], irrArray);
    sensitivity.push({
      key: cfg.key,
      label: cfg.label,
      correlation: corr,
      absCorrelation: Math.abs(corr),
    });
  }
  sensitivity.sort((a, b) => b.absCorrelation - a.absCorrelation);

  // ── Scatter data (GOES price vs IRR, colored by duopoly timing) ──
  const scatter = results
    .filter(r => r.uIRR != null)
    .map(r => ({
      goesPrice: r.goesPrice,
      irr: r.uIRR,
      nipponYear: r.nipponYear,
      earlyDuopoly: r.nipponYear <= 5,
    }));

  return {
    results,
    stats,
    histogram,
    moicHistogram,
    sensitivity,
    scatter,
    probIRR: stats.probIRR,
  };
}
