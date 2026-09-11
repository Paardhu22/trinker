import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const fromRoot = (path: string): string => fileURLToPath(new URL(path, import.meta.url));
export default defineConfig({
  resolve: {
    alias: {
      "@trinker/compiler": fromRoot("./packages/compiler/src/index.ts"),
      "@trinker/core": fromRoot("./packages/core/src/index.ts"),
      "@trinker/oracles": fromRoot("./packages/oracles/src/index.ts"),
      "@trinker/report": fromRoot("./packages/report/src/index.ts"),
      "@trinker/surface": fromRoot("./packages/surface/src/index.ts"),
    },
  },
});
