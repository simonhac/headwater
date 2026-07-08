import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";
import { fileURLToPath } from "node:url";

// Workers project: runs test/integration/* inside the real Workers runtime (workerd) with an
// in-memory D1, so processEvent is exercised end-to-end against real SQL + our migrations.
export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(fileURLToPath(new URL("./migrations", import.meta.url)));
  return {
    resolve: {
      alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
    },
    test: {
      name: "workers",
      include: ["test/integration/**/*.test.ts"],
      setupFiles: ["./test/integration/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            compatibilityDate: "2025-11-01",
            compatibilityFlags: ["nodejs_compat"],
            bindings: {
              TEST_MIGRATIONS: migrations,
              POSTING_ENABLED: "true",
              SLACK_BOT_TOKEN: "xoxb-test-token",
              SLACK_DEFAULT_CHANNEL: "C_TEST",
            },
          },
        },
      },
    },
  };
});
