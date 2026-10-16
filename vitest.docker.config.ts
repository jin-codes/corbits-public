import { defineConfig } from "vitest/config";

// Starts the real sandbox containers (browser + gateway) under a separate compose project and
// port, so it never touches a stack you are running. Needs Docker and internet access.
export default defineConfig({
  test: { include: ["**/*.docker.test.ts"], testTimeout: 120_000, hookTimeout: 600_000, fileParallelism: false },
});
