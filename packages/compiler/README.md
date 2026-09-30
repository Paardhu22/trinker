# @trinker/compiler

The opt-in LLM compiler for [Trinker](https://github.com/Paardhu22/trinker). A model *proposes*
identities, invariants, and checks; every proposal is filtered and re-validated deterministically
before it can reach a plan, and a scan never calls a model.

The provider SDKs are optional peer dependencies. Install the one you use:

```bash
npm install openai            # --provider openai (default)
npm install @anthropic-ai/sdk # --provider anthropic
```
