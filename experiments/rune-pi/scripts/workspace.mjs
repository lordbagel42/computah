// Local-owner development tools, not a shell exposed by generated UI.

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const ROOT = fs.realpathSync(
  process.env.COMPUTAH_PROJECT_ROOT ?? path.resolve(import.meta.dirname, ".."),
);
const editable =
  /^(src\/[a-zA-Z_][a-zA-Z_0-9]*\.rs|scripts\/ui-catalog\.mjs|prompt\.txt|layout\.json|README\.md)$/;
const cargo = path.join(os.homedir(), ".cargo/bin/cargo");
function runeRoot() {
  const checkouts = path.join(os.homedir(), ".cargo/git/checkouts");
  const directory = fs
    .readdirSync(checkouts)
    .find(
      (name) =>
        name.startsWith("rune-") &&
        fs.existsSync(
          path.join(checkouts, name, "99c123d/crates/rune/src/lib.rs"),
        ),
    );
  if (!directory) throw new Error("Pinned Rune source is not cached");
  return fs.realpathSync(path.join(checkouts, directory, "99c123d"));
}
export function sourcePath(relative, write = false) {
  if (
    typeof relative !== "string" ||
    path.isAbsolute(relative) ||
    relative.split("/").includes("..")
  )
    throw new Error("Use a project-relative source path");
  const library = relative.startsWith("rune/");
  if (library && write) throw new Error("Rune dependency is read-only");
  if (!library && !editable.test(relative))
    throw new Error("Only Computah UI source/catalog files are exposed");
  const root = library ? runeRoot() : ROOT;
  const target = path.resolve(root, library ? relative.slice(5) : relative);
  const parent = fs.realpathSync(path.dirname(target));
  if (parent !== root && !parent.startsWith(root + path.sep))
    throw new Error("Outside source root");
  if (fs.existsSync(target)) {
    const real = fs.realpathSync(target);
    if (real !== target || !real.startsWith(root + path.sep))
      throw new Error("Symlink source targets are not allowed");
    if (fs.statSync(real).size > 2 * 1024 * 1024)
      throw new Error("Source file exceeds budget");
  }
  return target;
}
export function readSource(relative, offset = 1, limit = 180) {
  const lines = fs.readFileSync(sourcePath(relative), "utf8").split("\n");
  const first = Math.max(1, Math.floor(offset));
  return (
    lines
      .slice(first - 1, first - 1 + Math.min(300, Math.max(1, limit)))
      .map((line, index) => `${first + index}: ${line}`)
      .join("\n") + `\n(${lines.length} lines total)`
  );
}
export function editSource(relative, oldText, newText) {
  const target = sourcePath(relative, true);
  const text = fs.readFileSync(target, "utf8");
  if (!oldText || text.split(oldText).length !== 2)
    throw new Error("Old text must match exactly once; reread source");
  const next = text.replace(oldText, newText);
  if (Buffer.byteLength(next) > 2 * 1024 * 1024)
    throw new Error("Source exceeds budget");
  fs.writeFileSync(target, next);
  return "Source edited. Run build_ui; errors must be repaired before the running app changes.";
}
export function writeSource(relative, content) {
  const target = sourcePath(relative, true);
  if (Buffer.byteLength(content) > 2 * 1024 * 1024)
    throw new Error("Source exceeds budget");
  fs.writeFileSync(target, content);
  return "Source written. Run build_ui to verify and activate.";
}
export function workspaceInfo() {
  const fonts = [];
  for (const folder of [
    "/System/Library/Fonts/Supplemental",
    "/Library/Fonts",
    path.join(os.homedir(), "Library/Fonts"),
  ]) {
    if (fs.existsSync(folder))
      fonts.push(
        ...fs
          .readdirSync(folder)
          .filter((name) => /\.(ttf|otf|ttc)$/i.test(name)),
      );
  }
  return {
    root: ROOT,
    sourceFiles: fs
      .readdirSync(path.join(ROOT, "src"))
      .filter((n) => n.endsWith(".rs")),
    catalog: "scripts/ui-catalog.mjs",
    editable:
      "src/*.rs, scripts/ui-catalog.mjs, prompt.txt, layout.json, README.md",
    runeReadOnly: "rune/crates/rune/src/ (pinned dependency source)",
    installedFonts: fonts,
    fontLicensing:
      "Installed OS/user fonts may be used locally; do not copy or redistribute their files.",
    policy:
      "No shell tool, credentials, history reads, unrelated projects, package/dependency changes, deployment or infrastructure tools. Compiled owner-approved source runs locally with user privileges, not an OS security sandbox.",
  };
}
export async function buildUI(signal, progress = () => {}) {
  const environment = {
    HOME: os.homedir(),
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    TMPDIR: os.tmpdir(),
  };
  const sdk = "/Library/Developer/CommandLineTools/SDKs/MacOSX26.5.sdk";
  if (process.platform === "darwin" && fs.existsSync(sdk))
    environment.SDKROOT = sdk;
  const commands = [
    [process.execPath, ["--check", "scripts/self-tools.ts"]],
    [process.execPath, ["--check", "scripts/ui-worker.mjs"]],
    [process.execPath, ["--test", "scripts/ui-catalog.test.mjs"]],
    [cargo, ["fmt"]],
    [cargo, ["clippy", "--locked", "--all-targets", "--", "-D", "warnings"]],
    [cargo, ["test", "--locked"]],
    [cargo, ["build", "--locked"]],
  ];
  let output = "";
  for (const [command, args] of commands) {
    progress(`${path.basename(command)} ${args[0]}`);
    await new Promise((resolve, reject) => {
      const child = spawn(command, args, {
        cwd: ROOT,
        env: environment,
        detached: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stop = () => {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {}
      };
      const timer = setTimeout(stop, 180000);
      signal?.addEventListener("abort", stop, { once: true });
      if (signal?.aborted) stop();
      const collect = (data) => {
        output = (output + data.toString()).slice(-48000);
      };
      child.stdout.on("data", collect);
      child.stderr.on("data", collect);
      child.on("error", reject);
      child.on("close", (code) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        if (code === 0 && !signal?.aborted) resolve();
        else reject(new Error(output || "Build cancelled/failed"));
      });
    });
  }
  return (
    output +
    "\nVerified build ready. Return the requested json-render UI via render_ui, then the host saves state and relaunches automatically."
  );
}
