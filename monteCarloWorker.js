// ─── Monte Carlo Web Worker ────────────────────────────────────────────────
// Runs Monte Carlo simulation off the main thread.
// modelEngine.js is pure JS with no DOM dependencies — safe for Workers.

import { runModel } from "./modelEngine.js";
import { runMonteCarlo } from "./monteCarloEngine.js";

self.onmessage = function (e) {
  const { baseInputs, variableConfigs, n } = e.data;

  const onProgress = (done, total) => {
    self.postMessage({ type: "progress", done, total });
  };

  try {
    const result = runMonteCarlo(runModel, baseInputs, variableConfigs, n, onProgress);

    // probIRR is a closure over the sorted IRR array — can't be serialized via structured clone.
    // Pre-compute probability of exceeding each threshold and send the plain object instead.
    // Thresholds chosen to span typical PE hurdle rates (8%, 10%, 12%, 15%) and aspirational (20%, 25%).
    const probabilities = {
      8: result.probIRR(0.08),   // P(IRR ≥ 8%)  — minimum PE hurdle
      10: result.probIRR(0.10),  // P(IRR ≥ 10%) — common limited partnership hurdle
      12: result.probIRR(0.12),  // P(IRR ≥ 12%) — lower bound of attractive PE return
      15: result.probIRR(0.15),  // P(IRR ≥ 15%) — typical PE target return
      20: result.probIRR(0.20),  // P(IRR ≥ 20%) — strong PE return
      25: result.probIRR(0.25),  // P(IRR ≥ 25%) — exceptional PE return
    };

    self.postMessage({
      type: "result",
      stats: result.stats,
      histogram: result.histogram,
      moicHistogram: result.moicHistogram,
      sensitivity: result.sensitivity,
      scatter: result.scatter,
      probabilities,
    });
  } catch (err) {
    self.postMessage({ type: "error", message: err.message });
  }
};
