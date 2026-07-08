import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Node project: the fast pure-function unit tests. The Workers-pool integration tests live in
// test/integration and run under vitest.workers.config.ts (combined via vitest.workspace.ts).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    name: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["test/integration/**"],
  },
});
