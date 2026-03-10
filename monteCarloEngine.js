// ─── Monte Carlo Simulation Engine ─────────────────────────────────────────
// Pure JS — no React, no DOM. Designed to run in a Web Worker.
// Provides distribution sampling, simulation orchestration, and statistical analysis.

// ─── Standard Normal CDF & Inverse CDF ──────────────────────────────────────

/** Standard normal CDF using rational approximation (Abramowitz & Stegun 26.2.17) */
function normalCDF(x) {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;

  const sign = x < 0 ? -1 : 1;
  const absX = Math.abs(x);
  const t = 1.0 / (1.0 + p * absX);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2);
  return 0.5 * (1.0 + sign * y);
}

/** Sample standard normal using Box-Muller transform */
function sampleStdNormal() {
  let u1, u2;
  do { u1 = Math.random(); } while (u1 === 0);
  u2 = Math.random();
  return Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
}

// ─── Inverse CDF Functions ──────────────────────────────────────────────────

/** Inverse CDF for uniform distribution */
function inverseCDFUniform(u, min, max) {
  return min + u * (max - min);
}

/** Inverse CDF for triangular distribution */
function inverseCDFTriangular(u, min, mode, max) {
  const fc = (mode - min) / (max - min);
  if (u < fc) return min + Math.sqrt(u * (max - min) * (mode - min));
  return max - Math.sqrt((1 - u) * (max - min) * (max - mode));
}

/** Inverse CDF for discrete uniform distribution */
function inverseCDFDiscreteUniform(u, min, max) {
  return Math.floor(min + u * (max - min + 1));
}

/** Transform a uniform [0,1] value to the target distribution */
function inverseCDFVariable(u, config) {
  const clampedU = Math.max(1e-10, Math.min(1 - 1e-10, u));
  const { distribution, min, max, mode } = config;
  if (distribution === "triangular") return inverseCDFTriangular(clampedU, min, mode, max);
  if (distribution === "discrete_uniform") return inverseCDFDiscreteUniform(clampedU, min, max);
  return inverseCDFUniform(clampedU, min, max);
}

// ─── Cholesky Decomposition ─────────────────────────────────────────────────

/**
 * Cholesky decomposition of a symmetric positive-definite matrix.
 * Returns the lower triangular matrix L such that L * L^T = A.
 * @param {number[][]} A - n×n symmetric positive-definite matrix
 * @returns {number[][]} L - lower triangular matrix
 */
export function choleskyDecompose(A) {
  const n = A.length;
  const L = Array.from({ length: n }, () => new Array(n).fill(0));

  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let sum = 0;
      for (let k = 0; k < j; k++) {
        sum += L[i][k] * L[j][k];
      }
      if (i === j) {
        const diag = A[i][i] - sum;
        L[i][j] = Math.sqrt(Math.max(0, diag));
      } else {
        L[i][j] = L[j][j] !== 0 ? (A[i][j] - sum) / L[j][j] : 0;
      }
    }
  }
  return L;
}

// ─── Default Correlations ───────────────────────────────────────────────────

export const DEFAULT_CORRELATIONS = {
  "goesPrice|goesProductionCost": 0.4,
  "entryMultiple|exitMultiple": 0.6,
  "duopolyImpact|goesPrice": -0.3,
};

/**
 * Build an n×n correlation matrix for the given variable keys using the
 * provided correlation map. Keys in the correlation map are "varA|varB"
 * with alphabetically sorted variable keys.
 */
function buildCorrelationMatrix(keys, correlations) {
  const n = keys.length;
  const matrix = Array.from({ length: n }, () => new Array(n).fill(0));

  // Identity diagonal
  for (let i = 0; i < n; i++) matrix[i][i] = 1;

  // Fill off-diagonal from correlation map
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const pairKey1 = `${keys[i]}|${keys[j]}`;
      const pairKey2 = `${keys[j]}|${keys[i]}`;
      const rho = correlations[pairKey1] ?? correlations[pairKey2] ?? 0;
      matrix[i][j] = rho;
      matrix[j][i] = rho;
    }
  }
  return matrix;
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
  txPriceEscalation: {
    label: "TX Price Escalation",
    key: "txPriceEscalation",
    distribution: "triangular",
    min: 0.03, mode: 0.07, max: 0.12,
    format: "pct",
  },
  txBaseEBITDAMargin: {
    label: "TX Existing Margin",
    key: "txBaseEBITDAMargin",
    distribution: "triangular",
    min: 0.08, mode: 0.125, max: 0.20,
    format: "pct",
  },
  cpiRate: {
    label: "CPI / Inflation",
    key: "cpiRate",
    distribution: "triangular",
    min: 0.015, mode: 0.025, max: 0.045,
    format: "pct",
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
export function runMonteCarlo(runModel, baseInputs, variableConfigs, n = 1000, onProgress = null, correlations = DEFAULT_CORRELATIONS) {
  const results = [];
  const sampledInputs = {}; // key -> array of sampled values

  // Initialize sampled input arrays
  for (const cfg of variableConfigs) {
    sampledInputs[cfg.key] = [];
  }

  // Build correlation matrix and Cholesky factor for enabled variables
  const keys = variableConfigs.map(cfg => cfg.key);
  const corrMatrix = buildCorrelationMatrix(keys, correlations);
  const L = choleskyDecompose(corrMatrix);
  const m = keys.length;

  for (let i = 0; i < n; i++) {
    // Generate correlated samples:
    // 1. Sample independent standard normals
    const z = new Array(m);
    for (let k = 0; k < m; k++) z[k] = sampleStdNormal();

    // 2. Apply Cholesky L to induce correlations: w = L * z
    const w = new Array(m);
    for (let row = 0; row < m; row++) {
      let s = 0;
      for (let col = 0; col <= row; col++) s += L[row][col] * z[col];
      w[row] = s;
    }

    // 3. Transform correlated normals to target distributions via inverse CDF
    const iterInputs = { ...baseInputs };
    for (let k = 0; k < m; k++) {
      const u = normalCDF(w[k]); // correlated uniform via Phi(w)
      const val = inverseCDFVariable(u, variableConfigs[k]);
      iterInputs[keys[k]] = val;
      sampledInputs[keys[k]].push(val);
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
