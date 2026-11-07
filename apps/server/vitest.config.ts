import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig } from "vitest/config";

// The native test engine must not share a data directory with other checkouts.
process.env.HOME = mkdtempSync(join(tmpdir(), "computah-core-engine-"));
process.env.RIVET_RUN_ENGINE_PORT = String(
  30_000 + Math.floor(Math.random() * 200) * 100,
);

export default defineConfig({
  test: {
    pool: "forks",
    maxWorkers: 1,
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
