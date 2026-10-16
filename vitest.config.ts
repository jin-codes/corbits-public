import { defineConfig } from "vitest/config";

// Default run: deterministic tests only (mock adapters, local Postgres). Live provider tests
// live in *.live.test.ts and run via `pnpm test:live` because they cost money and need keys.
// Tests that start the sandbox containers are *.docker.test.ts and run via `pnpm test:docker`.
export default defineConfig({
  test: { exclude: ["**/node_modules/**", "**/*.live.test.ts", "**/*.docker.test.ts"], testTimeout: 30_000, hookTimeout: 30_000 },
});
