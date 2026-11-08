// Explicit local owner capability. NOT installed in the durable core or UI action catalog.
// Editable Rust executes as the OS user: an allowlist is not a sandbox.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const owned = new Set([
  "src/main.rs",
  "src/document.rs",
  "layout.json",
  "scripts/ui-catalog.mjs",
  "scripts/ui-catalog.test.mjs",
]);
export async function sourcePath(name) {
  if (!owned.has(name)) throw new Error("Not an owner-editable UI source");
  const path = resolve(root, name);
  if ((await realpath(path)) !== path)
    throw new Error("Symlink source not allowed");
  return path;
}
const digest = (value) => createHash("sha256").update(value).digest("hex");
async function run(file, args) {
  const env = Object.fromEntries(
    ["PATH", "HOME", "CARGO_HOME", "RUSTUP_HOME", "SDKROOT"]
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]]),
  );
  await new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: root,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let size = 0;
    const forward = (chunk) => {
      size += chunk.length;
      if (size <= 64000) process.stderr.write(chunk);
    };
    child.stdout.on("data", forward);
    child.stderr.on("data", forward);
    const timer = setTimeout(() => child.kill(), 600000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      code === 0
        ? resolve()
        : reject(new Error("Owner check failed; active binary unchanged"));
    });
  });
}
async function main() {
  const [operation, name, base] = process.argv.slice(2);
  if (operation === "read") {
    const content = await readFile(await sourcePath(name), "utf8");
    process.stdout.write(JSON.stringify({ sha256: digest(content), content }));
  } else if (operation === "write") {
    const path = await sourcePath(name);
    let input = "";
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 256 * 1024)
        throw new Error("Source exceeds budget");
    }
    if (digest(await readFile(path)) !== base)
      throw new Error(
        "Source changed; read the current revision before writing",
      );
    await writeFile(path, input);
    process.stdout.write(
      JSON.stringify({
        sha256: digest(input),
        message:
          "Local edit saved; build required. Cancellation does not undo source edits.",
      }),
    );
  } else if (operation === "build") {
    await run("node", [
      "--test",
      "scripts/ui-catalog.test.mjs",
      "scripts/backend.test.mjs",
    ]);
    await run("cargo", ["fmt", "--check"]);
    await run("cargo", [
      "clippy",
      "--locked",
      "--all-targets",
      "--",
      "-D",
      "warnings",
    ]);
    await run("cargo", ["test", "--locked"]);
    await run("cargo", ["build", "--locked"]);
    const hash = digest(
      await readFile(resolve(root, "target/debug/computah-native")),
    );
    await writeFile(resolve(root, "target/candidate.sha256"), hash);
    process.stdout.write(
      JSON.stringify({
        sha256: hash,
        message:
          "Candidate built; running app unchanged. Use relaunch to checkpoint and replace.",
      }),
    );
  } else if (operation === "verify-candidate") {
    const candidate = resolve(root, "target/debug/computah-native");
    const marker = JSON.parse(await readFile(`${name}.relaunch`, "utf8"));
    if (marker.candidateHash !== digest(await readFile(candidate)))
      throw new Error("Candidate hash mismatch");
    const verified = spawnSync(candidate, ["--verify-state"], {
      env: { ...process.env, COMPUTAH_STATE: name },
      stdio: "ignore",
      timeout: 10000,
    });
    if (verified.status !== 0)
      throw new Error("Candidate cannot read checkpoint");
  } else if (operation === "relaunch") {
    // An already-running app consumes this owner-only marker, checkpoints and spawns the
    // fixed candidate. Generated UI has neither filesystem access nor this operation.
    if (!name) throw new Error("Provide the active COMPUTAH_STATE path");
    const candidate = resolve(root, "target/debug/computah-native");
    if (
      digest(await readFile(candidate)) !==
      (await readFile(resolve(root, "target/candidate.sha256"), "utf8"))
    )
      throw new Error("Candidate changed; rebuild first");
    const state = resolve(name);
    if ((await realpath(dirname(state))) !== dirname(state))
      throw new Error("Symlink state directory not allowed");
    await writeFile(
      `${state}.relaunch`,
      JSON.stringify({ candidateHash: digest(await readFile(candidate)) }),
      { mode: 0o600 },
    );
    process.stdout.write(
      JSON.stringify({
        message:
          "Relaunch requested. Native app validates the current checkpoint before quitting.",
      }),
    );
  } else
    throw new Error(
      "Use read <source>, write <source> <base-sha> on stdin, build, or relaunch <active-state-path>",
    );
}
if (process.argv[1] === fileURLToPath(import.meta.url))
  main().catch(() => {
    process.stderr.write(
      "Owner operation rejected or check failed; existing app/state retained.\n",
    );
    process.exitCode = 1;
  });
