# 🔌 commandcode-proxy

> **OpenAI Chat Completions → CommandCode `/alpha/generate` shim**
>
> Zero-dependency Bun + TypeScript proxy that lets [OpenCode](https://opencode.ai) talk to [CommandCode Go](https://commandcode.ai) via a local OpenAI-compatible endpoint.

## What it does

OpenCode speaks OpenAI Chat Completions. CommandCode Go speaks `POST /alpha/generate` (NDJSON). This proxy sits in between and translates both directions:

- **Out:** system/user/assistant/tool messages → `ModelMessage[]`, tools → `{name, description, input_schema}`
- **In:** NDJSON `text-delta` → `content`, `reasoning-delta` → `reasoning_content`, `tool-input-delta` → `tool_calls` chunks, `finish` → `finish_reason`

Always streams upstream; buffers when downstream asks `stream:false`.

## Install

### Mac / Linux

```sh
curl -fsSL https://github.com/shivamnarkar47/commandcode-proxy/raw/main/install.sh | bash
```

Or manually:

```sh
git clone https://github.com/shivamnarkar47/commandcode-proxy.git ~/.config/opencode/commandcode-proxy
cd ~/.config/opencode/commandcode-proxy
bun install
bun run src/setup.ts
```

### Windows

```ps1
irm https://github.com/shivamnarkar47/commandcode-proxy/raw/main/install.ps1 | iex
```

Or manually:

```powershell
git clone https://github.com/shivamnarkar47/commandcode-proxy.git $env:USERPROFILE\.config\opencode\commandcode-proxy
cd $env:USERPROFILE\.config\opencode\commandcode-proxy
bun install
bun run src/setup.ts
```

### Uninstall

Full removal (stops background processes, removes the boot service, strips the `commandcode` provider from `opencode.json(c)`, deletes this folder):

```sh
bun run uninstall
```

Flags: `--yes` (skip confirm), `--dry-run` (preview), `--keep-config`, `--dir <path>`. Details: [`docs/uninstall.md`](docs/uninstall.md).

Service-only removal (keeps folder + config):

```sh
bun run src/setup.ts --uninstall
```

## Run

If you prefer to run without installing as a service:

```sh
# No env needed if you already ran /connect (key in ~/.local/share/opencode/auth.json).
# Key resolution order: COMMANDCODE_API_KEY env → Bearer header → auth.json.
bun run src/proxy.ts --port 18731
```

### Dev mode

```sh
bun --watch run src/proxy.ts --port 18731
```

### Background run

Run detached (log + PID file next to `proxy.ts`):

```sh
bun run src/proxy.ts --daemon   # start in background
bun run src/proxy.ts --status   # running (PID xxxx) / not running
bun run src/proxy.ts --stop     # stop it
```

Shortcuts: `bun run daemon|status|stop|restart`. Wrapper scripts with `start|stop|status|restart`: `scripts/start.sh` (Linux/macOS, nohup) and `scripts\start.ps1` (Windows, hidden window). Double-start is refused and stale PID files self-heal. Details: [`docs/background-run.md`](docs/background-run.md).

### Install as a service

```sh
bun run src/setup.ts
```

This creates a systemd user service (Linux), launchd agent (macOS), or scheduled task (Windows) that starts the proxy on boot — and starts it immediately. If the service fails to come up, setup falls back to a background daemon (`--daemon`), so the proxy is live on first go either way.

To uninstall:

```sh
bun run src/setup.ts --uninstall
```

### Windows

Works on Windows too. Auth.json lookup order:

- `%APPDATA%\opencode\auth.json`
- `%LOCALAPPDATA%\opencode\auth.json`

Run with `bun` from PowerShell/CMD.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health`, `/v1/health` | Health check |
| `GET` | `/v1/models`, `/models` | Static model list |
| `POST` | `/v1/chat/completions`, `/chat/completions` | Main translation endpoint |

## opencode.json

Two providers are registered (the direct one is listed first, so it's the default):

| Provider | baseURL | Path |
|----------|---------|------|
| `commandcode-direct` | `https://api.commandcode.ai/provider/v1` | Direct OpenAI-compatible endpoint — no conversion, sends straight through |
| `commandcode` | `http://127.0.0.1:18731/v1` | Local proxy → `POST /alpha/generate` |

Set `provider.commandcode.options.baseURL` to `http://127.0.0.1:18731/v1`. Models carry an explicit `id` (canonical id sent upstream as `params.model`).

> **v1 & v2 compatible.** Use the **singular** `provider` top-level key with `npm: "@ai-sdk/openai-compatible"`. A plural `providers` block is silently ignored by OpenCode v1 and rejected as malformed by opencode2 / v2 — this is the most common cause of models not appearing. `thinking.budgetTokens` is camelCase.

Two template files are included for reference:

| File | Use when |
|------|----------|
| `opencode.json` | You want a plain JSON config (no comments) |
| `opencode.jsonc` | You want a JSONC config with inline documentation |

Copy the `provider.commandcode` block from either file into your `~/.config/opencode/opencode.json` (or `opencode.jsonc`), then restart OpenCode (or press F5 to reload; for opencode2 restart its background service with `opencode2 service restart`).

## Thinking / reasoning params

The proxy passes `thinking` and `reasoning_effort` through to upstream (`params.thinking`, `params.reasoningEffort`). Different models support different thinking variants — pass them in your OpenAI request body:

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [...],
  "thinking": { "type": "enabled", "budget_tokens": 8000 }
}
```

Or with OpenAI-style effort:

```json
{
  "model": "deepseek/deepseek-v4-flash",
  "messages": [...],
  "reasoning_effort": "high"
}
```

Upstream emits `reasoning-delta` NDJSON events; the proxy accumulates them into `reasoning_content` on the assistant message (both streamed and non-streamed responses).

## Variants in opencode.json

To select thinking variants from OpenCode's UI (`/models` → pick variant), define them under each model's `variants` object. Variant values are merged into the request body and forwarded by the proxy:

```jsonc
{
  "provider": {
    "commandcode": {
      "models": {
        "deepseek/deepseek-v4-flash": {
          "variants": {
            "low": { "reasoningEffort": "low" },
            "medium": { "reasoningEffort": "medium" },
            "high": { "reasoningEffort": "high" },
            "max": { "reasoningEffort": "high", "thinking": { "type": "enabled", "budgetTokens": 16000 } }
          }
        },
        "meituan/LongCat-2.0:free": {
          "variants": {
            "think": { "thinking": { "type": "enabled", "budgetTokens": 8000 } }
          }
        }
      }
    }
  }
}
```

Select at runtime with `provider/model#variant`, e.g. `commandcode/deepseek/deepseek-v4-flash#max`.

## Benchmarks

Local proxy overhead (2026-09-05, Linux, Bun 1.4.0, localhost):

| Metric | Value |
|--------|-------|
| Cold start → first healthy `/health` | ~47 ms |
| `GET /health` latency, p50 / p95 | 246 µs / 752 µs (n=100, in-process) |

No end-to-end generation benchmarks yet (needs an upstream API key). Method, reproduce commands, and limitations: [`docs/benchmarks.md`](docs/benchmarks.md). Smoke-test matrix: [`docs/smoke-tests.md`](docs/smoke-tests.md).

## Project structure

```
commandcode-proxy/
├── src/
│   ├── proxy.ts          # Bun.serve server, routing, key resolution, streaming, --daemon/--stop/--status
│   ├── translate.ts      # pure translation functions (no server)
│   ├── types.ts          # wire protocol types (OpenAI + Alpha + NDJSON)
│   └── setup.ts          # install/uninstall system service
├── scripts/
│   ├── start.sh          # background wrapper (Linux/macOS, nohup)
│   ├── start.ps1         # background wrapper (Windows, hidden window)
│   └── uninstall.ts      # full removal (service + config + folder)
├── docs/
│   ├── agents/           # agent skills config (issue tracker, triage labels, domain docs)
│   ├── adr/              # architectural decision records
│   ├── background-run.md # background-run options, runtime files, troubleshooting
│   ├── smoke-tests.md    # test matrix + results
│   ├── benchmarks.md     # method + numbers + reproduce commands
│   └── uninstall.md      # uninstall flags + behavior
├── config/
│   ├── opencode.json     # template: plain JSON config
│   ├── opencode.jsonc    # template: documented JSONC config
│   └── service.json      # systemd descriptor
├── AGENTS.md             # agent skills entry point (tracker, labels, domain docs)
├── CONTEXT.md            # domain glossary + translation rules
├── package.json          # bun scripts, bun-types devDep
├── tsconfig.json         # strict, bundler resolution, bun-types
└── README.md
```

## Contributing

Agent workflows are documented in [`AGENTS.md`](AGENTS.md): issues live in GitHub Issues, triage uses the five canonical labels (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`), and domain language lives in [`CONTEXT.md`](CONTEXT.md) with decisions in [`docs/adr/`](docs/adr/).

## License

MIT
