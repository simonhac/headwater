/// <reference types="@cloudflare/vitest-pool-workers" />
import type { readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    TEST_MIGRATIONS: Awaited<ReturnType<typeof readD1Migrations>>;
    POSTING_ENABLED: string;
    SLACK_BOT_TOKEN: string;
    SLACK_DEFAULT_CHANNEL: string;
  }
}
