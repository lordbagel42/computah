// User-local source installation. Never overwrites another app or changes credentials.
import { spawnSync } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runtimeLog,
  startObservability,
  traceOperation,
} from "@computah/observability";

const telemetry = await startObservability("native").catch(() => ({
  close: async () => {},
}));
try {
  await traceOperation("native.process", async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const prefix = process.argv[2];
    if (!prefix || !isAbsolute(prefix))
      throw new Error(
        "Provide a new absolute installation directory (not a state directory)",
      );
    const destination = resolve(prefix);
    await mkdir(dirname(destination), { recursive: true });
    const stage = await mkdtemp(
      join(dirname(destination), ".computah-install-"),
    );
    let reserved = false;
    try {
      for (const [file, args] of [
        ["cargo", ["build", "--locked"]],
        [
          "pnpm",
          [
            "--filter",
            "@computah/native",
            "deploy",
            "--prod",
            "--legacy",
            "--ignore-scripts",
            join(stage, "app"),
          ],
        ],
      ]) {
        const result = spawnSync(file, args, { cwd: root, stdio: "inherit" });
        if (result.status !== 0)
          throw new Error("Install build/dependency check failed");
      }
      await mkdir(join(stage, "bin"));
      await copyFile(
        join(root, "target/debug/computah-native"),
        join(stage, "app/computah-native"),
      );
      await writeFile(
        join(stage, "bin/computah-native"),
        `#!/bin/sh
set -eu
COMPUTAH_APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../app" && pwd)
export COMPUTAH_APP_DIR
exec "$COMPUTAH_APP_DIR/computah-native" "$@"
`,
        { mode: 0o755 },
      );
      // mkdir is exclusive even if the destination is an existing empty directory.
      await mkdir(destination);
      reserved = true;
      await rename(stage, destination);
      reserved = false;
      console.log(
        `Installed launcher: ${join(destination, "bin/computah-native")}`,
      );
      console.log(
        "Existing state, apps, credentials and PATH were not changed.",
      );
      runtimeLog("native.process", { outcome: "success" });
    } finally {
      await rm(stage, { recursive: true, force: true });
      // Remove only our empty reservation, never another process's contents.
      if (reserved) await rmdir(destination).catch(() => {});
      // pnpm's legacy --prod deploy changes workspace install metadata. Restore
      // the frozen development install so later source checks remain runnable.
      const restored = spawnSync(
        "pnpm",
        ["install", "--frozen-lockfile", "--ignore-scripts"],
        { cwd: root, stdio: "inherit" },
      );
      if (restored.status !== 0) {
        runtimeLog("native.process", { outcome: "error" }, "error");
        console.error(
          "Restore the frozen workspace install before source checks",
        );
        process.exitCode = 1;
      }
    }
  });
} catch {
  runtimeLog("native.process", { outcome: "error" }, "error");
  console.error(
    "Installation failed; existing app/state retained. Use a new absolute prefix and check build prerequisites.",
  );
  process.exitCode = 1;
} finally {
  await telemetry.close();
}
