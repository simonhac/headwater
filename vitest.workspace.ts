import { defineWorkspace } from "vitest/config";

// `pnpm test` runs both projects: fast node unit tests + the Workers-pool integration tests.
export default defineWorkspace(["./vitest.config.ts", "./vitest.workers.config.ts"]);
