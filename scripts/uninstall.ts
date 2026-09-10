#!/usr/bin/env bun
// scripts/uninstall.ts — Fully remove commandcode-proxy.
// Stops background processes, removes the system service, strips the
// `commandcode` provider from opencode.json / opencode.jsonc, and deletes
// the install folder. Zero deps.
// Usage: bun run scripts/uninstall.ts [--yes] [--dry-run] [--keep-config] [--dir <path>]

import os from "node:os";
import path from "node:path";
import { existsSync, rmSync, readdirSync } from "node:fs";

const argv = process.argv.slice(2);
const YES = argv.includes("--yes");
const DRY = argv.includes("--dry-run");
const KEEP_CONFIG = argv.includes("--keep-config");
const dirIdx = argv.indexOf("--dir");
const TARGET_DIR =
  dirIdx >= 0 && argv[dirIdx + 1] ? path.resolve(argv[dirIdx + 1]!) : path.resolve(import.meta.dirname, "..");
const SELF_FILE = path.resolve(import.meta.filename);

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

const log = (...a: unknown[]) => console.log("[uninstall]", ...a);
const warn = (...a: unknown[]) => console.warn("[uninstall]", ...a);

async function run(cmd: string[]): Promise<void> {
  try {
    const proc = Bun.spawn({ cmd, stdout: "inherit", stderr: "inherit" });
    await proc.exited;
  } catch (e) {
    warn(`command failed: ${cmd.join(" ")}\n  ${(e as Error).message}`);
  }
}

// --- platform paths (mirrors src/setup.ts) ---
function configDir(): string {
  if (IS_WIN) return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(os.homedir(), ".config");
}

// --- 1. stop PID-tracked background process ---
async function stopDaemon(): Promise<void> {
  const pidFile = path.join(TARGET_DIR, ".commandcode-proxy.pid");
  if (!existsSync(pidFile)) {
    log("no background process (no PID file)");
    return;
  }
  const pid = parseInt((await Bun.file(pidFile).text()).trim(), 10);
  if (DRY) {
    log(`would stop PID ${pid} and remove ${pidFile}`);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    log(`stopped background process (PID ${pid})`);
  } catch {
    log(`stale PID file (PID ${pid} not responding)`);
  }
  rmSync(pidFile, { force: true });
}

// --- 2. remove system service (mirrors src/setup.ts uninstallService) ---
async function removeService(): Promise<void> {
  if (DRY) {
    log("would remove system service (systemd/launchd/scheduled task)");
    return;
  }
  if (IS_LINUX) {
    await run(["systemctl", "--user", "disable", "--now", "commandcode-proxy"]);
    rmSync(path.join(os.homedir(), ".config", "systemd", "user", "commandcode-proxy.service"), { force: true });
    await run(["systemctl", "--user", "daemon-reload"]);
  } else if (IS_MAC) {
    const f = path.join(os.homedir(), "Library", "LaunchAgents", "ai.commandcode.proxy.plist");
    await run(["launchctl", "unload", f]);
    rmSync(f, { force: true });
  } else if (IS_WIN) {
    await run(["schtasks", "/Delete", "/TN", "CommandCodeProxy", "/F"]);
  } else {
    warn("unknown platform — skipping service removal");
    return;
  }
  log("system service removed");
}

// --- 3. strip provider from opencode.json / opencode.jsonc ---
function removeProviderFromJson(text: string, name: string): string | null {
  let cfg: Record<string, unknown>;
  try {
    cfg = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  const providers = cfg.provider as Record<string, unknown> | undefined;
  if (!providers || !(name in providers)) return null;
  delete providers[name];
  if (Object.keys(providers).length === 0) delete cfg.provider;
  return JSON.stringify(cfg, null, 2) + "\n";
}

// Textual removal for JSONC (comments break JSON.parse). Finds the
// `"commandcode": { ... }` block with a string/comment-aware brace matcher.
function removeProviderFromJsonc(text: string, name: string): string | null {
  const keyRe = new RegExp(`"${name}"\\s*:\\s*\\{`, "g");
  const m = keyRe.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length; // just after the opening {
  let depth = 1;
  let inStr: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let end = -1;
  for (; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1] ?? "";
    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  if (end < 0) return null;
  let start = m.index;
  let stop = end;
  // Swallow one adjacent comma to keep the JSON valid.
  let j = stop;
  while (j < text.length && /\s/.test(text[j]!)) j++;
  if (text[j] === ",") {
    stop = j + 1;
  } else {
    j = start - 1;
    while (j >= 0 && /\s/.test(text[j]!)) j--;
    if (text[j] === ",") start = j;
  }
  return text.slice(0, start) + text.slice(stop);
}

async function stripProviderConfig(): Promise<void> {
  if (KEEP_CONFIG) {
    log("keeping opencode config (--keep-config)");
    return;
  }
  const dir = path.join(configDir(), "opencode");
  const names = ["commandcode-direct", "commandcode"];
  for (const file of ["opencode.json", "opencode.jsonc"]) {
    const p = path.join(dir, file);
    if (!existsSync(p)) continue;
    let raw = await Bun.file(p).text();
    let removedAny = false;
    for (const name of names) {
      const next =
        file.endsWith(".jsonc")
          ? (removeProviderFromJson(raw, name) ?? removeProviderFromJsonc(raw, name))
          : removeProviderFromJson(raw, name);
      if (next === null) continue;
      raw = next;
      removedAny = true;
      if (DRY) log(`would remove ${name} provider from ${p}`);
    }
    if (!removedAny) {
      log(`${file}: no commandcode provider found, skipping`);
      continue;
    }
    if (DRY) continue;
    await Bun.write(p, raw);
    log(`removed commandcode provider(s) from ${p}`);
  }
}

// --- 4. delete the install folder ---
function removeDir(): void {
  if (DRY) {
    log(`would delete ${TARGET_DIR}`);
    return;
  }
  try {
    rmSync(TARGET_DIR, { recursive: true, force: true });
    log(`deleted ${TARGET_DIR}`);
  } catch (e) {
    // On Windows the running script file may be locked — remove everything else.
    warn(`could not delete folder directly (${(e as Error).message}), removing contents instead`);
    for (const entry of readdirSync(TARGET_DIR)) {
      const p = path.join(TARGET_DIR, entry);
      if (path.resolve(p) === SELF_FILE) continue;
      rmSync(p, { recursive: true, force: true });
    }
    warn(`leftovers may remain in ${TARGET_DIR} (including this script) — delete manually`);
  }
}

async function confirm(): Promise<boolean> {
  if (YES || DRY) return true;
  if (!process.stdin.isTTY) {
    warn("not a TTY — re-run with --yes to confirm, or --dry-run to preview");
    return false;
  }
  const answer = prompt(
    `Delete ${TARGET_DIR} and remove the commandcode provider from opencode config?\nType "yes" to continue: `,
  );
  return answer?.trim().toLowerCase() === "yes";
}

async function main(): Promise<void> {
  log(`target: ${TARGET_DIR}`);
  if (!(await confirm())) {
    log("aborted");
    process.exit(1);
  }
  await stopDaemon();
  await removeService();
  await stripProviderConfig();
  removeDir();
  log("done. auth.json keys were left untouched (re-run /connect to reuse them).");
}

main().catch((e: Error) => {
  console.error("[uninstall]", e.message);
  process.exit(1);
});
