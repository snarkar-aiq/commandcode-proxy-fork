# CONTEXT.md — commandcode-proxy

Glossary and domain language for this repo. Skills use these terms verbatim; don't drift to synonyms.

## What this is

OpenAI Chat Completions → CommandCode `/alpha/generate` shim. Zero-dependency Bun + TypeScript proxy letting OpenCode talk to CommandCode Go via a local OpenAI-compatible endpoint.

## Glossary

| Term | Meaning |
| ---- | ------- |
| Downstream | OpenCode, speaking OpenAI Chat Completions (SSE or buffered JSON) to the proxy |
| Upstream | CommandCode Go, speaking `POST /alpha/generate` (NDJSON) |
| Proxy (`src/proxy.ts`) | Local endpoint translating downstream requests upstream and streaming events back |
| Translator (`src/translate.ts`) | Maps OpenAI messages/tools ↔ `ModelMessage[]` / `{name, description, input_schema}` |
| Wire types (`src/types.ts`) | Canonical OpenAI, SSE, and Alpha/NDJSON shapes |
| Model catalog (`src/models.json`) | Single source of truth for model ids/names/variants — consumed by proxy, setup, and config templates |
| Setup (`src/setup.ts`) | Installs the proxy as a service and registers the `commandcode` provider |

## Translation rules

- **Out (downstream → upstream):** system/user/assistant/tool messages → `ModelMessage[]`; tools → `{name, description, input_schema}`.
- **In (upstream → downstream):** `text-delta` → `content`, `reasoning-delta` → `reasoning_content`, `tool-input-delta` → `tool_calls` chunks, `finish` → `finish_reason`.
- Always streams upstream; buffers when downstream asks `stream: false`.
