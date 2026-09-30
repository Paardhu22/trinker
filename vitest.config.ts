import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      "@trinker_vul/compiler": fromRoot("./packages/compiler/src/index.ts"),
      "@trinker_vul/core": fromRoot("./packages/core/src/index.ts"),
      "@trinker_vul/oracles": fromRoot("./packages/oracles/src/index.ts"),
      "@trinker_vul/report": fromRoot("./packages/report/src/index.ts"),
      "@trinker_vul/vitest": fromRoot("./packages/vitest/src/index.ts"),
      "@trinker_vul/surface": fromRoot("./packages/surface/src/index.ts"),
    },
  },
});
