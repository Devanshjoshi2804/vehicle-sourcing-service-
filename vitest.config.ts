import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    hookTimeout: 30000,
    setupFiles: ["dotenv/config"],
    // Integration tests share one Postgres test DB and TRUNCATE between files;
    // run files sequentially so one file's reset can't wipe another's rows mid-run.
    fileParallelism: false,
  },
});
