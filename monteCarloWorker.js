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

    // probIRR is a function — compute common thresholds before sending
    const probabilities = {
      8: result.probIRR(0.08),
      10: result.probIRR(0.10),
      12: result.probIRR(0.12),
      15: result.probIRR(0.15),
      20: result.probIRR(0.20),
      25: result.probIRR(0.25),
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
