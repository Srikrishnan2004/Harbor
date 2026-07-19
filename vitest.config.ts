import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["engine/test/**/*.test.ts"],
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: "forks",
  },
});
