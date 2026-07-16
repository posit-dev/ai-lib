# ai-config

Owns the full lifecycle of `~/.posit/ai/providers.json`: the schema, validation, defaults, the resolution pipeline that turns a raw file into an effective provider catalog, and the filesystem seams that load, watch, and mutate the file safely across processes.

This package is part of the [`ai-lib`](../../README.md) monorepo. It is a dependency-light leaf: it does **not** import `ai-provider-bridge` or `ai-credentials`. Compatibility with the bridge's vocabulary (provider IDs, protocols, client kinds) is enforced at compile time by a [shape guard](../../typechecks), not by an import edge.

## Entrypoints

The package splits pure (browser/test-safe) logic from filesystem I/O:

| Entrypoint                        | What it provides                                                                                                                                                                                                                                 | Node FS dep? |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------ |
| `ai-config`                       | Vocabulary (`BUILTIN_PROVIDER_IDS`, `PROTOCOL_VALUES`, `CLIENT_KIND_VALUES`, …), Zod schemas, inferred types, defaults, the `resolveProviderCatalog({ sources })` seam, pure helpers, and the model capability tables + `inferModelCapabilities` | No           |
| `ai-config/node`                  | The pure entry plus the three filesystem seams and path constants                                                                                                                                                                                | Yes          |
| `ai-config/positron`              | Builds a `host`-kind `ProviderConfigSource` from Positron `authentication.*` settings (+ change signal). The only entry that imports `vscode`.                                                                                                   | No (vscode)  |
| `ai-config/providers.schema.json` | The generated JSON Schema, for editor validation/autocomplete of `providers.json`                                                                                                                                                                | No           |

The three filesystem seams (`ai-config/node`):

- **`loadResolvedProviderCatalog(opts)`** — the single read entry point; returns `readonly ResolvedProvider[]`.
- **`mutateProvidersConfig(mutator, opts)`** — cross-process-safe read-modify-write.
- **`watchResolvedProviderCatalog(handler, opts)`** — emits typed `ProviderCatalogChange` events (`enabledChanged`, `connectionChanged`, `modelsChanged`).

## API Reference

### Pure entry (`ai-config`)

No filesystem access — safe in browsers, tests, and any JS runtime.

#### Vocabulary

```ts
import {
  BUILTIN_PROVIDER_IDS, // readonly tuple of built-in provider ids
  PROTOCOL_VALUES, // readonly tuple of wire protocols
  CLIENT_KIND_VALUES, // readonly tuple of client implementation kinds
  RESERVED_PROVIDER_KEYS, // ["default", "custom"]
  isBuiltinProviderId, // (value: string) => value is BuiltinProviderId
} from "ai-config";

import type { BuiltinProviderId, Protocol, ClientKind, ReservedProviderKey } from "ai-config";
```

`isBuiltinProviderId(value)` is a type guard that narrows an arbitrary string to `BuiltinProviderId`. These constants are the shared vocabulary kept in sync with `ai-provider-bridge` by the [shape guard](../../typechecks).

#### Schemas & validation

```ts
import { providersConfigSchema, enforcedProvidersConfigSchema } from "ai-config";

// Validate a parsed providers.json object:
const config = providersConfigSchema.parse(rawJson);

// The enforced variant relaxes custom-entry `type` to optional:
const enforced = enforcedProvidersConfigSchema.parse(rawFragment);
```

Both are Zod schemas. `providersConfigSchema` is the source of truth for the on-disk format and for the generated `providers.schema.json`. `enforcedProvidersConfigSchema` is the relaxed variant used to validate the `POSIT_AI_PROVIDERS_ENFORCED` / `POSIT_AI_PROVIDERS_DEFAULT` fragments before merging.

#### Types

| Type                                               | Description                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `ProvidersConfig`                                  | Root config — the complete `providers.json` file.                                     |
| `ProvidersMap`                                     | The `providers` map inside the config.                                                |
| `BuiltinProviderBlock`                             | A built-in provider block (no `type` field).                                          |
| `CustomProviderEntry`                              | A user-defined provider entry (`type` required).                                      |
| `DefaultBlock`                                     | The `providers.default` baseline block.                                               |
| `ModelsBlock`                                      | Per-provider model-selection block (`discovery`/`allow`/`deny`/`overrides`/`custom`). |
| `ModelOverride`                                    | Partial model-metadata patch (for `overrides`).                                       |
| `CustomModel`                                      | Complete custom-model definition (for the `custom` array).                            |
| `EnforcedProvidersConfig` / `EnforcedProvidersMap` | Relaxed variants where custom-entry `type` is optional.                               |
| `ResolvedProvider`                                 | A uniform resolved catalog entry (see below).                                         |
| `ResolvedConnection`                               | Non-secret connection config resolved from a provider block.                          |
| `ResolvedProviderId`                               | `BuiltinProviderId \| CustomProviderId`.                                              |
| `CustomProviderId`                                 | A branded custom id, produced only by `mintCustomProviderId()`.                       |
| `ModelInfoLike` / `ResolvedModelInfo`              | Input/output shapes for `resolveModels()`.                                            |
| `PlatformBaseline`                                 | How a platform expresses enablement defaults.                                         |

```ts
interface ResolvedProvider {
  readonly id: ResolvedProviderId;
  readonly clientKind: ClientKind; // client implementation to instantiate
  readonly enabled: boolean; // after all precedence layers
  readonly connection: ResolvedConnection;
  readonly models: ModelsBlock | undefined;
}
```

`ResolvedProvider` deliberately does **not** carry discovered models — those need credentials and a runtime fetcher that `ai-config` cannot hold. Use `resolveModels()` for that step.

#### `mintCustomProviderId(id: string): CustomProviderId`

The one sanctioned producer of the branded `CustomProviderId`. Validates the id against built-in and reserved-key collisions; **throws** if the id is empty, collides with a built-in id, or is a reserved key (`default`, `custom`).

#### `resolveProviderCatalog(opts): readonly ResolvedProvider[]`

The **deep resolver seam** — the one place that owns the entire precedence stack. It takes an ordered list of `ProviderConfigSource`s plus a `PlatformBaseline` and returns a fully resolved catalog. Hosts only _contribute sources_; precedence knowledge (rank per kind, the sealed-enforced invariant, deep-merge and array-replace rules) lives here.

```ts
function resolveProviderCatalog(opts: {
  sources: readonly ProviderConfigSource[]; // any order — ranked by `kind`
  baseline: PlatformBaseline;
  envVars?: Record<string, string | undefined>; // non-secret connection overlay (default {})
}): readonly ResolvedProvider[];
```

A `ProviderConfigSource` declares _what it is_ via `kind`, not _where it sits_. The resolver maps each kind to a fixed rank, highest → lowest: **`enforced` > `user` > `host` > `default`**, with the `PlatformBaseline` beneath all sources. The `enforced` layer is a **sealed overlay** — no lower source can overwrite an enforced key (a correctness invariant). Object fields deep-merge per leaf-key; `allow`/`deny` arrays wholesale-replace.

`mergeEnforced` (two-layer) and `mergeConfigFragments` (layered) remain exported as the low-level merge primitives, but consumers should assemble sources and call `resolveProviderCatalog` rather than merging by hand.

#### `resolveModels(modelsBlock, discovered, providerConnection?): ResolvedModelInfo[]`

The one resolver that stays public because it needs runtime-discovered models.

```ts
function resolveModels(
  modelsBlock: ModelsBlock | undefined,
  discovered: readonly ModelInfoLike[],
  providerConnection?: ResolvedConnection,
): ResolvedModelInfo[];
```

Pipeline: start from discovered + custom models → apply `overrides` by id → filter to `allow` (exclusive allowlist, when non-empty) → subtract `deny` (always wins) → resolve each survivor's protocol and base URL. Routing precedence is user-configured (override/custom) → provider config → discovered-model inference. Each result gains `resolvedProtocol` and `resolvedBaseUrl`.

#### Defaults

```ts
import {
  PROVIDER_CONNECTION_DEFAULTS, // map: provider id -> default connection
  POSIT_AI_DEFAULTS,
  OLLAMA_DEFAULTS,
  LMSTUDIO_DEFAULTS,
  BEDROCK_DEFAULTS,
  GOOGLE_VERTEX_DEFAULTS,
} from "ai-config";
```

Built-in default connection config (base URLs, endpoints) applied as the lowest precedence layer beneath the file and env-var overlays.

#### Model capability inference

```ts
import {
  getAnthropicModelCapabilities,
  getDeepSeekModelCapabilities,
  getGeminiModelCapabilities,
  getGemmaModelCapabilities,
  getOpenAIModelCapabilities,
  openaiMaxInputTokens,
  getPositAiModelCapabilities,
  inferModelCapabilities,
} from "ai-config";

import type { InferredModelCapabilities } from "ai-config";
```

The per-provider `get*ModelCapabilities(modelId)` helpers are pure, regex-driven lookups that map a provider-specific model id to a `Partial<InferredModelCapabilities>` (or `undefined`/a default object when the id doesn't match that provider's family). `openaiMaxInputTokens(caps)` derives the OpenAI input-token ceiling from a capability object's context window and output-token reservation.

`inferModelCapabilities(providerId, modelId)` is the single entry point that ties the tables together: it merges a conservative generic baseline (128k context, tools on, no images, no web search) under whichever provider-family table applies, with the table's values winning per field. It also derives `supportsImages` from a table's `supportedInputMediaTypes` when the table sets media types but leaves the flag itself unset, and resolves `protocol` for `snowflake-cortex` ids (Claude ids → `"anthropic-messages"`, everything else → `"openai-chat"` after stripping a leading `openai-` prefix). The result is shaped to spread straight into a `models.custom` entry, so it omits `requiresChatTemplateKwargs` (a runtime-only flag the strict custom-model schema rejects). It's the intended delegation target for any consumer that needs model capabilities without the bridge's dependency tree.

`ai-provider-bridge` re-exports the per-provider `get*ModelCapabilities` helpers and `openaiMaxInputTokens` from its own root for existing consumers, but not `inferModelCapabilities` — import that from `ai-config` directly.

---

### Node entry (`ai-config/node`)

Re-exports everything above, and adds the filesystem seams. Requires Node.

#### Paths

```ts
import { AI_CONFIG_DIR, PROVIDERS_CONFIG_PATH } from "ai-config/node";
// ~/.posit/ai  and  ~/.posit/ai/providers.json
```

#### `loadResolvedProviderCatalog(opts): Promise<readonly ResolvedProvider[]>`

The single read seam. Assembles the config sources (the user file → `{}` if missing, the `POSIT_AI_PROVIDERS_ENFORCED` / `POSIT_AI_PROVIDERS_DEFAULT` env fragments, and any `additionalSources`), delegates precedence to `resolveProviderCatalog`, applies the platform baseline, and returns the resolved catalog. The read path degrades gracefully — malformed/missing files log a warning and fall back rather than throwing.

```ts
const catalog = await loadResolvedProviderCatalog({
  baseline: { defaultEnabled: true },
});
```

`LoadCatalogOptions`:

| Field                 | Description                                                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `baseline` (required) | `PlatformBaseline` — enablement defaults for this platform.                                                                                    |
| `configPath?`         | Override the file path (testing).                                                                                                              |
| `enforcedEnvVar?`     | Override the enforced env-var name (defaults to `POSIT_AI_PROVIDERS_ENFORCED`; testing).                                                       |
| `defaultEnvVar?`      | Override the defaults env-var name (defaults to `POSIT_AI_PROVIDERS_DEFAULT`; testing).                                                        |
| `envVars?`            | Source for the non-secret connection overlay **and** the enforced/default fragment env vars (defaults to `process.env`).                       |
| `additionalSources?`  | Extra watchable `ProviderConfigSourceProvider`s (e.g. a Positron `authentication.*` `host` source). Folded into both the load and watch paths. |
| `logger?`             | `LoggerLike` for diagnostics/validation warnings.                                                                                              |

#### `mutateProvidersConfig(mutator, opts?): Promise<void>`

Cross-process-safe read-modify-write. The `mutator` receives the current validated config and returns the new one. Returning the same object is a valid no-op (the write still happens; it's idempotent). The seam owns all write safety: `proper-lockfile` locking with stale reclamation, an in-process serialization queue per path, race-safe first creation (`wx`), atomic temp-file-plus-rename writes, and seed-metadata (`$schema`, `version`) injection on first creation.

```ts
await mutateProvidersConfig((current) => ({
  ...current,
  providers: {
    ...current.providers,
    anthropic: { ...current.providers?.anthropic, enabled: true },
  },
}));
```

`MutateConfigOptions`: `configPath?`, `logger?`.

#### `watchResolvedProviderCatalog(handler, opts): Disposable`

The single watch seam. Debounced (~300ms), ancestor-aware `fs.watch` that reloads, diffs against the previous catalog, and invokes `handler` only when something actually changed. Returns a `Disposable` — call `.dispose()` to stop.

```ts
const sub = watchResolvedProviderCatalog(
  (change) => {
    if (change.enabledChanged) reregisterProviders(change.catalog);
    if (change.connectionChanged) invalidateModelCaches(change.catalog);
    if (change.modelsChanged) refreshModelLists(change.catalog);
  },
  { baseline: { defaultEnabled: true } },
);
// later:
sub.dispose();
```

`WatchCatalogOptions` extends `LoadCatalogOptions`. The `ProviderCatalogChange` event carries the full new `catalog` plus the three boolean flags shown above.

#### Node-only types

`LoadCatalogOptions`, `MutateConfigOptions`, `WatchCatalogOptions`, `ProviderCatalogChange`, `Disposable`, `LoggerLike`.

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

Config flows through **assemble sources → resolve → watch**:

1. **Assemble sources**: the node seam reads the user file (missing → `{}`, validated against `providersConfigSchema`), the enforced fragment from `POSIT_AI_PROVIDERS_ENFORCED`, and the defaults fragment from `POSIT_AI_PROVIDERS_DEFAULT` (both validated against the relaxed `enforcedProvidersConfigSchema`), plus any `additionalSources` (e.g. a Positron `authentication.*` `host` source). Each becomes a `ProviderConfigSource` tagged with its `kind`.
2. **Resolve** (`resolveProviderCatalog`): rank the sources by kind (`enforced` > `user` > `host` > `default`), fold them low → high so the sealed `enforced` overlay can never be overwritten, apply the `PlatformBaseline` beneath, and build `ResolvedProvider[]` — objects deep-merge per leaf-key, `allow`/`deny` arrays wholesale-replace, and a non-secret env-var overlay applies on top.
3. **Watch** (`watchResolvedProviderCatalog`): debounced (~300ms), ancestor-aware watch over **every** source (file via `fs.watch`; host sources emit their own change signals; env sources are static) that re-resolves, diffs against the previous catalog, and emits a typed change only when something actually changed.

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
