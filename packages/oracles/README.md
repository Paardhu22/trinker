# @trinker_vul/oracles

The three deterministic oracles used by [Trinker](https://github.com/Paardhu22/trinker):

- `differentialAuthorizationOracle` — Broken Object Level Authorization, confirmed only on a
  byte-identical response to an identity that should have been denied
- `stateMutationOracle` — an unauthorized write that provably changed protected state
- `metamorphicResponseOracle` — a response that depends on a parameter it should ignore

None of them uses heuristics or scores: anything short of mechanical evidence is `inconclusive`.
