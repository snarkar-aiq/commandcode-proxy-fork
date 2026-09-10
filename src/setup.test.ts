import { describe, expect, test } from "bun:test";
import path from "node:path";
import {
  buildModels,
  buildProviderConfig,
  buildDirectProviderConfig,
  mergeProviderJsonc,
  stripJsonComments,
  hasComments,
} from "./setup.js";
import modelsJson from "./models.json";

const SNIPPET = `"commandcode": {\n    "name": "New"\n  }`;

describe("models.json is the single source of truth", () => {
  const ids = modelsJson.models.map((m) => m.id);

  test("buildModels() mirrors models.json exactly", () => {
    const models = buildModels();
    expect(Object.keys(models)).toEqual(ids);
    for (const m of modelsJson.models) {
      expect(models[m.id]).toEqual({ id: m.id, name: m.name, variants: m.variants });
    }
  });

  for (const file of ["opencode.json", "opencode.jsonc"]) {
    test(`config/${file} lists every model in both providers`, async () => {
      const p = path.join(import.meta.dirname, "..", "config", file);
      const cfg = JSON.parse(stripJsonComments(await Bun.file(p).text())) as {
        provider: Record<string, { models: Record<string, unknown> }>;
      };
      for (const name of ["commandcode", "commandcode-direct"]) {
        expect(Object.keys(cfg.provider[name]!.models)).toEqual(ids);
      }
    });
  }
});

describe("stripJsonComments / hasComments", () => {
  test("strips line and block comments, keeps strings", () => {
    const out = stripJsonComments('{"a": "x//y", "b": 1 /* c */} // trailing');
    expect(out).not.toContain("trailing");
    expect(out).not.toContain("/* c */");
    expect(out).toContain("x//y");
  });

  test("detects comments outside strings", () => {
    expect(hasComments('{"a": 1} // hi')).toBe(true);
    expect(hasComments('{"a": "x//y"}')).toBe(false);
    expect(hasComments('{"a": 1}')).toBe(false);
  });
});

describe("mergeProviderJsonc", () => {
  test("replaces existing block, preserves comments", () => {
    const raw = `{
  // top comment
  "provider": {
    // inner comment
    "commandcode": { "name": "Old" },
    "other": { "x": 1 }
  }
}`;
    const merged = mergeProviderJsonc(raw, SNIPPET)!;
    expect(merged).not.toBeNull();
    expect(merged).toContain("// top comment");
    expect(merged).toContain("// inner comment");
    expect(merged).toContain('"name": "New"');
    expect(merged).not.toContain('"name": "Old"');
    expect(merged).toContain('"other"');
  });

  test("inserts into existing provider without commandcode", () => {
    const raw = `{
  "provider": {
    "other": { "x": 1 }
  }
}`;
    const merged = mergeProviderJsonc(raw, SNIPPET)!;
    expect(merged).toContain(SNIPPET);
    expect(merged).toContain('"other"');
  });

  test("creates provider block when missing", () => {
    const raw = `{
  "$schema": "https://opencode.ai/config.json"
}`;
    const merged = mergeProviderJsonc(raw, SNIPPET)!;
    expect(merged).toContain('"provider"');
    expect(merged).toContain(SNIPPET);
  });

  test("returns null on unbalanced input", () => {
    expect(mergeProviderJsonc(`{ "provider": { "commandcode": { `, SNIPPET)).toBeNull();
  });

  test("always emits the singular 'provider' key, never plural 'providers'", () => {
    const withExisting = mergeProviderJsonc(
      `{
  // keep me
  "provider": { "other": { "x": 1 } }
}`,
      SNIPPET,
    )!;
    expect(withExisting).toContain('"provider"');
    expect(withExisting).not.toContain('"providers"');

    const fromScratch = mergeProviderJsonc(`{
  "$schema": "https://opencode.ai/config.json"
}`, SNIPPET)!;
    expect(fromScratch).toContain('"provider"');
    expect(fromScratch).not.toContain('"providers"');
  });
});

describe("buildProviderConfig (OpenCode v1/v2 schema)", () => {
  test("uses npm + options (v1/v2) instead of package + settings (v0)", () => {
    const cfg = buildProviderConfig(false);
    expect(cfg.npm).toBe("@ai-sdk/openai-compatible");
    expect((cfg as unknown as Record<string, unknown>).package).toBeUndefined();
    expect(cfg.options.baseURL).toMatch(/:\/\/127\.0\.0\.1:18731/);
    expect((cfg as unknown as Record<string, unknown>).settings).toBeUndefined();
  });

  test("adds env for COMMANDCODE_API_KEY when no key is configured", () => {
    expect(buildProviderConfig(false).env).toEqual(["COMMANDCODE_API_KEY"]);
    expect(buildProviderConfig(true).env).toBeUndefined();
  });

  test("models carry id, an object variants map, and camelCase budgetTokens", () => {
    const cfg = buildProviderConfig(false);
    expect(cfg.models).not.toBeUndefined();
    for (const model of Object.values(cfg.models) as Array<Record<string, unknown>>) {
      expect(model.id).toBeDefined();
      expect(model.modelID).toBeUndefined();
      const variants = model.variants as Record<string, unknown>;
      expect(typeof variants).toBe("object");
      expect(variants).not.toBeNull();
      expect(Array.isArray(variants)).toBe(false);
      // any thinking payload must be camelCase, not snake_case
      expect(JSON.stringify(variants)).not.toContain("budget_tokens");
    }
  });

  test("deepseek model exposes the expected thinking variants", () => {
    const cfg = buildProviderConfig(false);
    const ds = cfg.models["deepseek/deepseek-v4-flash"] as {
      id: string;
      name: string;
      variants: Record<string, unknown>;
    };
    expect(ds.id).toBe("deepseek/deepseek-v4-flash");
    expect(Object.keys(ds.variants)).toEqual(["low", "medium", "high", "max"]);
    expect(ds.variants.max).toEqual({
      reasoningEffort: "high",
      thinking: { type: "enabled", budgetTokens: 16000 },
    });
  });
});

describe("buildDirectProviderConfig (GOAT endpoint)", () => {
  test("points at the direct OpenAI-compatible endpoint, no proxy", () => {
    const direct = buildDirectProviderConfig(true);
    expect(direct.options.baseURL).toBe("https://api.commandcode.ai/provider/v1");
    expect(direct.options.baseURL).not.toContain("127.0.0.1");
    expect(direct.npm).toBe("@ai-sdk/openai-compatible");
    expect(direct.name).toBe("CommandCode Direct (GOAT)");
  });

  test("shares the same model set and env behavior as the proxy config", () => {
    expect(Object.keys(buildDirectProviderConfig(true).models)).toEqual(
      Object.keys(buildProviderConfig(true).models),
    );
    expect(buildDirectProviderConfig(false).env).toEqual(["COMMANDCODE_API_KEY"]);
    expect(buildDirectProviderConfig(true).env).toBeUndefined();
  });
});

describe("mergeProviderJsonc ordered providers", () => {
  test("inserts a provider first without dropping existing ones", () => {
    const raw = `{
  "provider": {
    "commandcode": { "name": "Proxy" }
  }
}`;
    const merged = mergeProviderJsonc(raw, `"commandcode-direct": { "name": "Direct" }`, "commandcode-direct", true)!;
    expect(merged).not.toBeNull();
    const providers = merged.indexOf('"commandcode-direct"');
    expect(providers).toBeGreaterThan(-1);
    expect(providers).toBeLessThan(merged.indexOf('"commandcode"'));
    expect(merged).toContain('"name": "Proxy"');
  });
});
