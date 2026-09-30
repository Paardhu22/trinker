# @trinker/core

Plan and runtime schemas, the deterministic runner, the typed scan event stream, and the safety
gates (loopback-only by default, double-gated writes) behind [Trinker](https://github.com/Paardhu22/trinker).

Most people want the `trinker` CLI instead. Use this package to run a plan programmatically:

```ts
import { PlanSchema, RuntimeConfigSchema, runPlan } from "@trinker/core";
import { differentialAuthorizationOracle } from "@trinker/oracles";

const result = await runPlan({ plan, runtime, oracles: [differentialAuthorizationOracle] }).result;
```
