#!/usr/bin/env bun
// setup.ts — Automated setup for commandcode-proxy
// Usage: bun run setup.ts [--uninstall]
// Zero deps. Creates systemd service (Linux), launchd (macOS), or scheduled task (Windows).

import os from "node:os";
import path from "node:path";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import modelsJson from "./models.json";

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const IS_LINUX = process.platform === "linux";

const PORT = process.env.PORT || "18731";
const PROXY_URL = `http://127.0.0.1:${PORT}`;

// --- platform paths ---
function dataDir(): string {
  if (IS_WIN) return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  if (IS_MAC) return path.join(os.homedir(), "Library", "Application Support");
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}
function configDir(): string {
  if (IS_WIN) return process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(os.homedir(), ".config");
}
function opencodeDataDir(): string {
  return path.join(dataDir(), "opencode");
}
function opencodeConfigFile(): string {
  const dir = path.join(configDir(), "opencode");
  if (existsSync(path.join(dir, "opencode.jsonc"))) return path.join(dir, "opencode.jsonc");
  return path.join(dir, "opencode.json");
}
const PROXY_DIR = path.join(configDir(), "opencode", "commandcode-proxy");
const PROXY_FILE = path.join(PROXY_DIR, "proxy.ts");
const RUNTIME = process.env.BUN_PATH || process.execPath;

// --- helpers ---
const log = (...a: unknown[]) => console.log("[setup]", ...a);
const warn = (...a: unknown[]) => console.warn("[setup]", ...a);
const err = (...a: unknown[]) => console.error("[setup]", ...a);

async function readJsonSafe(p: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await Bun.file(p).text();
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function run(cmd: string[]): Promise<void> {
  try {
    const proc = Bun.spawn({
      cmd,
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  } catch (e) {
    warn(`command failed: ${cmd.join(" ")}\n  ${(e as Error).message}`);
  }
}

async function isPortOpen(port: string): Promise<boolean> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// --- provider config ---
// NOTE: emits the OpenCode v1/v2 schema (singular top-level `provider` key).
// OpenCode v1 silently drops a plural `providers` block and v2 rejects it as
// malformed; v1 only recognizes OpenAI-compatible providers when `npm` is
// "@ai-sdk/openai-compatible".
interface ProviderConfig {
  name: string;
  npm: string;
  env?: string[];
  options: { baseURL: string };
  models: Record<string, unknown>;
}

// Single source of truth: src/models.json. Consumed here (provider config),
// by proxy.ts (/v1/models), and by the config/ templates (kept in sync by test).
export function buildModels(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of modelsJson.models) {
    out[m.id] = { id: m.id, name: m.name, variants: m.variants };
  }
  return out;
}

export function buildProviderConfig(hasKey: boolean): ProviderConfig {
  const cfg: ProviderConfig = {
    name: "CommandCode Go (via local proxy)",
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: `${PROXY_URL}/v1` },
    models: buildModels(),
  };
  if (!hasKey) {
    cfg.env = ["COMMANDCODE_API_KEY"];
  }
  return cfg;
}

// Direct OpenAI-compatible endpoint (GOAT plan). No proxy conversion —
// OpenCode talks straight to /provider/v1/chat/completions.
export const DIRECT_BASE_URL = "https://api.commandcode.ai/provider/v1";

export function buildDirectProviderConfig(hasKey: boolean): ProviderConfig {
  const cfg: ProviderConfig = {
    name: "CommandCode Direct (GOAT)",
    npm: "@ai-sdk/openai-compatible",
    options: { baseURL: DIRECT_BASE_URL },
    models: buildModels(),
  };
  if (!hasKey) {
    cfg.env = ["COMMANDCODE_API_KEY"];
  }
  return cfg;
}

// --- service install ---
async function installSystemd(): Promise<void> {
  const serviceFile = path.join(os.homedir(), ".config", "systemd", "user", "commandcode-proxy.service");
  const unit = `[Unit]
Description=CommandCode Go local proxy for OpenCode
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${RUNTIME} run ${PROXY_FILE} --port ${PORT}
WorkingDirectory=${PROXY_DIR}
Restart=on-failure
RestartSec=3
Environment="PATH=/usr/local/bin:/usr/bin:/bin"

[Install]
WantedBy=default.target
`;
  await Bun.write(serviceFile, unit);
  await run(["systemctl", "--user", "daemon-reload"]);
  await run(["systemctl", "--user", "enable", "--now", "commandcode-proxy"]);
  log("systemd user service installed and started");
}

async function installLaunchd(): Promise<void> {
  const plistFile = path.join(os.homedir(), "Library", "LaunchAgents", "ai.commandcode.proxy.plist");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>ai.commandcode.proxy</string>
  <key>ProgramArguments</key>
  <array>
    <string>${RUNTIME}</string>
    <string>run</string>
    <string>${PROXY_FILE}</string>
    <string>--port</string>
    <string>${PORT}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROXY_DIR}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/commandcode-proxy.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/commandcode-proxy.err.log</string>
</dict>
</plist>
`;
  await Bun.write(plistFile, plist);
  await run(["launchctl", "unload", plistFile]);
  await run(["launchctl", "load", plistFile]);
  log("launchd agent installed and started");
}

async function installWindowsTask(): Promise<void> {
  const taskName = "CommandCodeProxy";
  const args = `run "${PROXY_FILE}" --port ${PORT}`;

  try {
    await run(["schtasks", "/Delete", "/TN", taskName, "/F"]);
  } catch {
    /* ignore */
  }

  const xmlPath = path.join(os.tmpdir(), "commandcode-proxy-task.xml");
  const xml = `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartInterval>PT1M</RestartInterval>
    <RestartCount>3</RestartCount>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${RUNTIME}</Command>
      <Arguments>${args}</Arguments>
      <WorkingDirectory>${PROXY_DIR}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
  await Bun.write(xmlPath, xml);
  await run(["schtasks", "/Create", "/TN", taskName, "/XML", xmlPath, "/F"]);
  await run(["schtasks", "/Run", "/TN", taskName]);
  rmSync(xmlPath, { force: true });
  log("Windows scheduled task installed and started");
}

async function uninstallService(): Promise<void> {
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
  }
  log("service uninstalled");
}

// --- opencode.json merge ---
export function stripJsonComments(text: string): string {
  let out = "";
  let inStr: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1] ?? "";
    if (inLineComment) {
      if (c === "\n") {
        inLineComment = false;
        out += c;
      }
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      } else if (c === "\n") {
        out += c;
      }
      continue;
    }
    if (inStr) {
      out += c;
      if (c === "\\") {
        out += next;
        i++;
      } else if (c === inStr) {
        inStr = null;
      }
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = c;
      out += c;
    } else if (c === "/" && next === "/") {
      inLineComment = true;
      i++;
    } else if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

// Find the range of `"key": { ... }` starting search at fromIdx, string/comment aware.
// Returns [start, stop) where start is at the opening quote and stop is just past `}`.
export function findKeyBlockRange(text: string, key: string, fromIdx = 0): [number, number] | null {
  const keyRe = new RegExp(`"${key}"\\s*:\\s*\\{`, "g");
  keyRe.lastIndex = fromIdx;
  const m = keyRe.exec(text);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  let inStr: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
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
      if (depth === 0) return [m.index, i + 1];
    }
  }
  return null;
}

export function hasComments(text: string): boolean {
  let inStr: string | null = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const next = text[i + 1] ?? "";
    if (inStr) {
      if (c === "\\") i++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === "/" && (next === "/" || next === "*")) return true;
  }
  return false;
}

// Surgical JSONC merge: replace/insert only the named provider block,
// preserving comments and formatting elsewhere. Returns null on failure.
// `name` is the provider key (default "commandcode"). When `atStart` is true a
// new block is inserted first inside `provider` instead of appended last.
export function mergeProviderJsonc(
  raw: string,
  providerSnippet: string,
  name = "commandcode",
  atStart = false,
): string | null {
  const providersRange = findKeyBlockRange(raw, "provider");
  if (!providersRange) {
    // No providers block: insert before final closing brace of root object.
    const stripped = stripJsonComments(raw).trim();
    if (!stripped.endsWith("}")) return null;
    const closeIdx = raw.lastIndexOf("}");
    if (closeIdx < 0) return null;
    const before = raw.slice(0, closeIdx).trimEnd();
    const needsComma = !before.endsWith("{") && before.length > 1;
    const after = raw.slice(closeIdx);
    return `${before}${needsComma ? "," : ""}\n  "provider": {\n    ${providerSnippet}\n  }\n${after}`;
  }
  const [pStart, pStop] = providersRange;
  const existing = findKeyBlockRange(raw, name, pStart);
  if (existing && existing[0] < pStop) {
    return raw.slice(0, existing[0]) + providerSnippet + raw.slice(existing[1]);
  }
  // Insert into existing providers object.
  const inner = raw.slice(pStart, pStop);
  const openBrace = inner.indexOf("{");
  const innerBody = inner.slice(openBrace + 1, inner.length - 1);
  if (stripJsonComments(innerBody).trim() === "") {
    return `${raw.slice(0, pStart)}"provider": {\n    ${providerSnippet}\n  }${raw.slice(pStop)}`;
  }
  if (atStart) {
    const insertAt = pStart + openBrace + 1;
    const afterInsert = raw.slice(insertAt).trimStart();
    const needsComma = !afterInsert.startsWith("}");
    return `${raw.slice(0, insertAt)}\n    ${providerSnippet}${needsComma ? "," : ""}\n  ${afterInsert}`;
  }
  const insertAt = pStop - 1;
  const beforeInsert = raw.slice(0, insertAt).trimEnd();
  const needsComma = !beforeInsert.endsWith("{") && !beforeInsert.endsWith(",");
  return `${beforeInsert}${needsComma ? "," : ""}\n    ${providerSnippet}\n  ${raw.slice(insertAt)}`;
}

async function ensureOpencodeConfig(hasKey: boolean): Promise<void> {
  const cfgPath = opencodeConfigFile();
  const snippetFor = (name: string, providerCfg: ProviderConfig): string => {
    const body = JSON.stringify(providerCfg, null, 2)
      .split("\n")
      .map((line, i) => (i === 0 ? line : `    ${line}`))
      .join("\n");
    return `"${name}": ${body}`;
  };
  const directSnippet = snippetFor("commandcode-direct", buildDirectProviderConfig(hasKey));
  const proxySnippet = snippetFor("commandcode", buildProviderConfig(hasKey));

  if (existsSync(cfgPath)) {
    const raw = await Bun.file(cfgPath).text();
    const isJsonc = cfgPath.endsWith(".jsonc") || hasComments(raw);
    if (isJsonc) {
      // Direct (GOAT) endpoint goes first; the proxy stays as the second option.
      let merged = mergeProviderJsonc(raw, directSnippet, "commandcode-direct", true);
      if (merged !== null) merged = mergeProviderJsonc(merged, proxySnippet, "commandcode");
      if (merged !== null) {
        await Bun.write(cfgPath, merged);
        log(`opencode config updated at ${cfgPath} (comments preserved)`);
        return;
      }
      warn(`could not safely edit ${cfgPath} — leaving comments intact; add the commandcode providers manually`);
      return;
    }
  }

  const cfg: Record<string, unknown> =
    (await readJsonSafe(cfgPath)) ?? { $schema: "https://opencode.ai/config.json" };

  const providers: Record<string, unknown> =
    (cfg.provider as Record<string, unknown> | undefined) ?? {};
  // Rebuild in order so the direct endpoint is listed first.
  providers["commandcode-direct"] = buildDirectProviderConfig(hasKey);
  providers.commandcode = buildProviderConfig(hasKey);
  cfg.provider = providers;

  await Bun.write(cfgPath, JSON.stringify(cfg, null, 2));
  log(`opencode.json updated at ${cfgPath}`);
}

// --- auth check ---
async function checkAuth(): Promise<boolean> {
  const authPath = path.join(opencodeDataDir(), "auth.json");
  const auth = await readJsonSafe(authPath);
  const entry =
    (auth?.commandcode as string | { key?: string } | undefined) ??
    (auth?.["commandcode-go"] as string | { key?: string } | undefined) ??
    (auth?.["opencode-go"] as string | { key?: string } | undefined);
  if (entry) {
    const k = typeof entry === "string" ? entry : entry?.key;
    log(`found key in auth.json (${k?.slice(0, 8)}...)`);
    return true;
  }
  if (process.env.COMMANDCODE_API_KEY) {
    log(`found key in env (${process.env.COMMANDCODE_API_KEY.slice(0, 8)}...)`);
    return true;
  }
  warn("no CommandCode key found — requests will 401 until you set COMMANDCODE_API_KEY or run /connect");
  return false;
}

// --- main ---
async function main(): Promise<void> {
  const uninstall = process.argv.includes("--uninstall");

  log(`platform: ${process.platform}`);
  log(`bun: ${process.execPath}`);

  if (uninstall) {
    await uninstallService();
    return;
  }

  // 1. Ensure proxy dir exists and proxy sources are in place
  // (proxy.ts imports ./translate.js, so all src files must be copied)
  const selfDir = import.meta.dirname || path.dirname(new URL(import.meta.url).pathname);
  mkdirSync(PROXY_DIR, { recursive: true });
  let copied = 0;
  for (const f of ["proxy.ts", "translate.ts", "types.ts", "warmup.ts", "models.json"]) {
    const src = path.join(selfDir, f);
    const dst = path.join(PROXY_DIR, f);
    if (existsSync(src) && src !== dst) {
      await Bun.write(dst, Bun.file(src));
      copied++;
    }
  }
  if (copied > 0) log(`copied ${copied} src file(s) to ${PROXY_DIR}`);
  else if (!existsSync(PROXY_FILE)) warn("proxy sources not found — place them next to setup.ts first");

  // 2. Check auth
  const hasKey = await checkAuth();

  // 3. Update opencode.json
  await ensureOpencodeConfig(hasKey);

  // 4. Install service
  if (IS_LINUX) await installSystemd();
  else if (IS_MAC) await installLaunchd();
  else if (IS_WIN) await installWindowsTask();
  else warn("unknown platform — service not installed, start manually: bun run proxy.ts --port 18731");

  // 5. Verify — fall back to a background daemon so the proxy is live immediately
  await new Promise((r) => setTimeout(r, 1500));
  if (await isPortOpen(PORT)) {
    log(`proxy is live at ${PROXY_URL}`);
  } else {
    warn("service didn't come up — starting background daemon instead");
    try {
      const proc = Bun.spawn({
        cmd: [RUNTIME, "run", PROXY_FILE, "--port", PORT, "--daemon"],
        cwd: PROXY_DIR,
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
    } catch (e) {
      warn(`daemon fallback failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 1500));
    if (await isPortOpen(PORT)) {
      log(`proxy is live at ${PROXY_URL} (background daemon)`);
    } else {
      warn("proxy didn't come up — check logs");
      return;
    }
  }
  log("done. restart OpenCode or press F5 to reload config.");
}

if (import.meta.main) {
  main().catch((e: Error) => {
    err(e.message);
    process.exit(1);
  });
}
