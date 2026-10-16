import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { include: ["**/*.live.test.ts"], testTimeout: 120_000 },
});
