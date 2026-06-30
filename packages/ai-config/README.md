# ai-config

Owns the full lifecycle of `~/.posit/genai/providers.json`: the schema, validation, defaults, the resolution pipeline that turns a raw file into an effective provider catalog, and the filesystem seams that load, watch, and mutate the file safely across processes.

This package is part of the [`ai-lib`](../../README.md) monorepo. It is a dependency-light leaf: it does **not** import `ai-provider-bridge` or `ai-credential-store`. Compatibility with the bridge's vocabulary (provider IDs, protocols, client kinds) is enforced at compile time by a [shape guard](../../typechecks), not by an import edge.

## Entrypoints

The package splits pure (browser/test-safe) logic from filesystem I/O:

| Entrypoint                        | What it provides                                                                                                                                                               | Node FS dep? |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `ai-config`                       | Vocabulary (`BUILTIN_PROVIDER_IDS`, `PROTOCOL_VALUES`, `CLIENT_KIND_VALUES`, …), Zod schemas, inferred types, defaults, and the pure helpers `resolveModels` / `mergeEnforced` | No           |
| `ai-config/node`                  | The pure entry plus the three filesystem seams and path constants                                                                                                              | Yes          |
| `ai-config/providers.schema.json` | The generated JSON Schema, for editor validation/autocomplete of `providers.json`                                                                                              | No           |

The three filesystem seams (`ai-config/node`):

- **`loadResolvedProviderCatalog(opts)`** — the single read entry point; returns `readonly ResolvedProvider[]`.
- **`mutateProvidersConfig(mutator, opts)`** — cross-process-safe read-modify-write.
- **`watchResolvedProviderCatalog(handler, opts)`** — emits typed `ProviderCatalogChange` events (`enabledChanged`, `connectionChanged`, `modelsChanged`).

## `providers.json` shape

```jsonc
{
  "$schema": "./providers.schema.json",
  "version": 1,
  "providers": {
    // built-in providers (one key per BUILTIN_PROVIDER_ID; no `type` field)
    "anthropic": {
      "enabled": true,
      "baseUrl": "https://api.anthropic.com",
      "customHeaders": { "x-example": "value" },
      "models": {
        "discovery": "auto", // "auto" | "off"
        "allow": ["claude-..."], // exclusive allowlist
        "deny": [], // always wins over allow
        "overrides": { "claude-...": { "maxOutputTokens": 8192 } },
        "custom": [
          /* full CustomModel definitions discovery doesn't return */
        ],
      },
    },
    // reserved keys
    "default": { "enabled": false }, // baseline enablement
    "custom": {
      // user-defined providers (require `type`)
      "my-gateway": { "type": "openai-compatible", "baseUrl": "https://...", "enabled": true },
    },
  },
}
```

## Resolution pipeline

Config flows through **load → enforce → build → watch**:

1. **Load** (`loadProvidersConfig`): read the file (missing → `{}`), validate against `providersConfigSchema`, read the enforced fragment from the `POSIT_GENAI_PROVIDERS_ENFORCED` env var, validate it against the relaxed `enforcedProvidersConfigSchema`.
2. **Enforce** (`mergeEnforced`): deep-merge enforced over user config (objects merge per-key, arrays replace, primitives override); re-validate the merged result.
3. **Build** (`buildCatalog`): assemble `ResolvedProvider[]` from the merged config + enforced map + platform baseline, applying the enablement and connection precedence ladders and a non-secret env-var overlay.
4. **Watch** (`watchResolvedProviderCatalog`): debounced (~300ms), ancestor-aware file watch that reloads, diffs against the previous catalog, and emits a typed change only when something actually changed.

The read path **degrades gracefully**: malformed or missing files log a warning and fall back rather than throwing.

## File I/O guarantees

`mutateProvidersConfig` owns cross-process write safety so callers just supply a mutator: a `proper-lockfile` lock (with retries and stale detection), an in-process serialization queue per path, race-safe first creation (exclusive `wx` flag), atomic write (temp file + rename), seed-metadata injection (`$schema`, `version`) on first creation, and a best-effort copy of `providers.schema.json` alongside the config.

## Development

```bash
npm install
npm run build           # tsc (prebuild regenerates providers.schema.json from the Zod schemas)
npm run generate-schema # regenerate providers.schema.json on demand
npm run check-types     # tsc --noEmit
npm run test            # vitest
npm run test:watch      # vitest watch mode
npm run clean           # remove dist/ and build artifacts
```

## Documentation

See [`memory-bank/aiConfig.md`](../../memory-bank/aiConfig.md) for the full architecture, and the main monorepo's `memory-bank/providerConfigFile.md` for the consumer-facing narrative of how this config drives provider enablement in Posit Assistant.
