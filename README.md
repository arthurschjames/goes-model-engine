# GOES-to-Transformer Financial Model Engine

Pure JavaScript financial engine for modeling a GOES (Grain-Oriented Electrical Steel) to power transformer vertical integration acquisition.

This repository contains **only the model logic** — no UI, no authentication, no deployment config. It is automatically synced from a private repository so the financial calculations are auditable and transparent.

## Files

| File | Description |
|------|-------------|
| `modelEngine.js` | Core financial engine (~700 lines). 10-year DCF model with GOES production, transformer manufacturing (existing + greenfield), debt amortization, working capital dynamics, depreciation schedules, and IRR/MOIC calculations. |
| `monteCarloEngine.js` | Monte Carlo simulation engine. Triangular/uniform/discrete distributions, Spearman rank correlation, percentile statistics. |
| `monteCarloWorker.js` | Web Worker wrapper for running Monte Carlo simulations off the main thread. |

## What the Model Does

Given ~60 input parameters (utilization rates, pricing, cost structures, capital structure, growth assumptions), `runModel(inputs)` returns:

- **10-year projection**: Revenue, EBITDA, D&A, taxes, unlevered/levered free cash flow per year
- **Segment breakdown**: Steel Mill (GOES production), TX Existing (transformer acquisition), TX Greenfield (new transformer plant)
- **Deal metrics**: Unlevered/levered IRR, equity MOIC, payback period, DCF enterprise value
- **Debt schedule**: Year-by-year amortization, optional cash sweep, debt balance at exit
- **Sensitivity data**: Entry/exit multiple grids, tornado chart ranges
- **Validation warnings**: Capacity checks, unrealistic multiple warnings, covenant flags

## Key Constants

| Constant | Value | Description |
|----------|-------|-------------|
| `NAMEPLATE` | 180,000 tons/yr | Steel mill nameplate GOES capacity |
| `DOE_CAPACITY` | 25,000 tons | Additional capacity from DOE induction furnace project |
| `DOE_TARGET_SAVINGS` | $80M/yr | Cost savings at full nameplate (~$444/ton) |
| `DOD_TONS` | 10,600 tons | DOD stockpile contract volume |
| `DOD_PRICE` | $7,550/ton | DOD contract price |
| `TAX_RATE` | 25% | Corporate tax rate |
| `DUOPOLY_TRANSITION_YEARS` | 4 | Gradual price compression when Nippon enters market |

## Usage

The engine is pure JavaScript with no dependencies. You can run it directly:

```js
import { runModel, SCENARIOS } from './modelEngine.js';

// Run with base case defaults
const result = runModel(SCENARIOS.BASE);

// Access outputs
console.log(result.summary);       // IRR, MOIC, payback, EV
console.log(result.years);         // 10-year annual projections
console.log(result.warnings);      // Validation warnings
console.log(result.sources);       // Sources & uses of funds
```

## Six Preset Scenarios

The engine includes six preset scenarios: **Bear**, **Base**, **Bull**, **GOES Only**, **VTC Acquisition**, and **Delta Star** — each with different assumptions for pricing, utilization, capital structure, and growth.

## License

This code is provided for audit and review purposes. All rights reserved.
