---
title: ai-config Architecture
description: Architecture of ai-config -- the providers.json schema, the load -> enforce -> build -> watch resolution pipeline, and the file I/O seams.
package: ai-config
---

# ai-config Architecture

## Overview

`ai-config` owns the full lifecycle of `~/.posit/genai/providers.json`: the
schema, validation, defaults, the resolution pipeline that turns a raw file into
an effective provider catalog, and the filesystem seams that load, watch, and
mutate the file safely across processes.

It is a dependency-light leaf: it does **not** import `ai-provider-bridge` or
`ai-credentials`. Compatibility with the bridge's vocabulary is enforced at
compile time by a shape guard (see [Shape Guard](#shape-guard)), not by an
import edge.

The richer consumer-facing narrative of how this config drives provider
enablement in Posit Assistant lives in the main monorepo's
`memory-bank/providerConfigFile.md`. This document covers the package itself.

## Entrypoints

The package has three entrypoints, splitting pure (browser/test-safe) logic from
filesystem I/O and vscode-bound wiring:

| Entrypoint                        | What it exports                                                                                                                                                                                      | External deps? |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `ai-config`                       | Vocabulary, Zod schemas, inferred types, defaults, the pure resolution helpers (`resolveModels`, `mergeEnforced`), and the config-source contracts                                                   | No             |
| `ai-config/node`                  | Re-exports the pure entry plus the three filesystem seams (`loadResolvedProviderCatalog`, `mutateProvidersConfig`, `watchResolvedProviderCatalog`) and path constants                                | Node FS        |
| `ai-config/positron`              | Builds a `host`-kind config source from Positron's `authentication.*` VS Code settings (injected via `additionalSources`); the pure `buildAuthenticationFragment` builder is testable without vscode | `vscode`       |
| `ai-config/providers.schema.json` | The generated JSON Schema, exported so editors can validate/autocomplete `providers.json`                                                                                                            | No             |

### Pure entry (`ai-config`)

- **Vocabulary** (`src/vocabulary.ts`): `BUILTIN_PROVIDER_IDS`, `CLIENT_KIND_VALUES`, `PROTOCOL_VALUES`, `RESERVED_PROVIDER_KEYS`, `isBuiltinProviderId()`, and the `BuiltinProviderId` / `ClientKind` / `Protocol` / `ReservedProviderKey` types.
- **Schemas** (`src/schema.ts`): `providersConfigSchema` (full, strict) and `enforcedProvidersConfigSchema` (relaxed — custom-entry `type` optional, for env-injected fragments).
- **Types** (`src/types.ts`): types inferred from the Zod schemas (`ProvidersConfig`, `ProvidersMap`, `BuiltinProviderBlock`, `CustomProviderEntry`, `ModelsBlock`, `ModelOverride`, `CustomModel`, …) plus resolution outputs (`ResolvedProvider`, `ResolvedConnection`, `ResolvedModelInfo`) and the branded `CustomProviderId`. `mintCustomProviderId()` is the **only** way to produce a `CustomProviderId`.
- **Defaults** (`src/defaults.ts`): per-provider connection defaults and the `PROVIDER_CONNECTION_DEFAULTS` map.
- **Resolution helpers**: `resolveModels()` and `mergeEnforced()` are pure and exported; `resolveEnabled()` / connection resolution are internal helpers used by the catalog builder.
- **Config-source contracts** (`src/config-source.ts`): `ProviderConfigSource`, `ProviderConfigSourceProvider`, and `Disposable` — the watchable source interfaces the resolver folds in via `additionalSources` (e.g. host layers). Re-exported from `ai-config/node` for back-compat, so consumers of the pure entry (like `ai-config/positron`) can name them without touching `/node`.
- **Constant**: `PROVIDERS_CONFIG_VERSION = 1` — the on-disk format version.

### Node entry (`ai-config/node`)

Re-exports the pure entry, plus:

- **Paths**: `GENAI_CONFIG_DIR` (`~/.posit/genai`) and `PROVIDERS_CONFIG_PATH`.
- **Read seam**: `loadResolvedProviderCatalog(opts)` — the single read entry point.
- **Write seam**: `mutateProvidersConfig(mutator, opts)` — cross-process-safe mutation.
- **Watch seam**: `watchResolvedProviderCatalog(handler, opts)` — emits typed `ProviderCatalogChange` events.
- **Types**: `LoadCatalogOptions`, `MutateConfigOptions`, `WatchCatalogOptions`, `ProviderCatalogChange`, `LoggerLike`, `Disposable`.

## Resolution Pipeline

Config flows through four stages: **load → enforce → build → watch**.

1. **Load** (`src/node/load-config.ts`, `loadProvidersConfig()`): read the file
   (missing → `{}`), parse, validate against `providersConfigSchema`, read the
   enforced fragment from the `POSIT_GENAI_PROVIDERS_ENFORCED` env var and
   validate it against the relaxed `enforcedProvidersConfigSchema`. Returns the
   user config, the enforced config, and the merged config.
2. **Enforce** (`src/enforce.ts`, `mergeEnforced()`): deep-merge enforced over
   user — objects merge per-key (enforced wins, user keys preserved), arrays
   replace wholesale, primitives override. The merged result is re-validated
   against the full schema.
3. **Build** (`src/node/build-catalog.ts`, `buildCatalog()`): assemble
   `ResolvedProvider[]` (built-ins + custom) from the merged config, the
   enforced providers map, and the platform baseline. Resolves enablement and
   connection per the precedence ladders below, applies the env-var overlay, and
   maps each provider to a `clientKind`.
4. **Build resolved catalog** (`src/node/load-catalog.ts`,
   `loadResolvedProviderCatalog()`): the public read seam — composes load +
   build and returns `readonly ResolvedProvider[]`.

### Model selection (`resolveModels`)

`resolveModels(modelsBlock, discovered, providerConnection)` runs the per-provider
model pipeline: discovery gate (`discovery: "auto" | "off"`) → merge discovered +
`custom` models → apply `overrides` → `allow` filter (exclusive allowlist) →
`deny` filter (always wins) → attach routing (protocol/baseUrl). It is pure and
reusable independent of the catalog builder.

### Precedence ladders

- **Enablement** (`resolveEnabled`): enforced per-provider > enforced default >
  user per-provider > user default > platform-baseline per-provider > baseline
  default.
- **Connection**: non-secret env-var overlay (highest) > enforced > user file >
  injected `host` sources (e.g. Positron `authentication.*` via
  `additionalSources`) > built-in defaults. Object keys deep-merge across layers.
- **Model routing**: user config (override/custom) > provider config > discovered
  model inference.

## File I/O Seams

All three filesystem operations are deep modules — callers get safety guarantees
without managing locking, atomicity, or watch lifecycle themselves.

- **Load** degrades gracefully: missing file, parse errors, and validation
  failures log a warning and fall back to `{}` (or the user config) rather than
  throwing.
- **Watch** (`src/node/watch-catalog.ts`) debounces ~300ms to coalesce rapid
  edits, is ancestor-aware (watches the nearest existing parent dir until the
  config dir appears), reloads + diffs on change, and emits a typed
  `ProviderCatalogChange` (`enabledChanged`, `connectionChanged`,
  `modelsChanged`) only when something actually changed. The initial load does
  not emit (no previous catalog to diff against).
- **Mutate** (`src/node/mutate-config.ts`) takes cross-process safety seriously:
  a `proper-lockfile` lock (with retries and stale detection), an in-process
  serialization queue per config path, race-safe first-creation via the
  exclusive `wx` flag, atomic write (temp file + rename), seed-metadata
  injection (`$schema`, `version`) on first creation, and a best-effort copy of
  `providers.schema.json` alongside the config for editor validation.

## Shape Guard

`typechecks/shape-guard.typecheck.ts` holds compile-time assertions (type-checked
on every build, never emitted) that keep `ai-config`'s vocabulary compatible with
`ai-provider-bridge` **without an import edge**:

- `BUILTIN_PROVIDER_IDS` exactly matches the bridge's `PROVIDER_IDS`.
- Model-override metadata field names are a subset of the bridge's `ModelInfo` keys.
- `PROTOCOL_VALUES` is a subset of the bridge's `Protocol`.
- `CLIENT_KIND_VALUES` maps onto provider IDs, allowing for the non-identity
  mappings (`aws` → `bedrock`, `snowflake` → `snowflake-cortex`).

If the bridge adds a provider, the guard fails until `ai-config` is updated, and
vice versa. `ai-config` types like `ModelInfoLike` are satisfied structurally by
the bridge's `ModelInfo` — compatible by contract, not by import.

## Code Layout

| Location                     | What it does                                                                                       |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| `src/vocabulary.ts`          | Provider-ID / protocol / client-kind / reserved-key value tuples + type guards                     |
| `src/schema.ts`              | Zod schemas (full + enforced variants) for `providers.json`                                        |
| `src/types.ts`               | Types inferred from Zod + resolution outputs + branded `CustomProviderId` / `mintCustomProviderId` |
| `src/defaults.ts`            | Built-in provider connection defaults; `PROVIDER_CONNECTION_DEFAULTS`                              |
| `src/enforce.ts`             | `mergeEnforced()` deep-merge of enforced over user config                                          |
| `src/resolve-enabled.ts`     | `resolveEnabled()` enablement precedence ladder                                                    |
| `src/resolve-connection.ts`  | Internal baseUrl/endpoint resolution precedence                                                    |
| `src/resolve-models.ts`      | `resolveModels()` model selection + routing pipeline                                               |
| `src/index.ts`               | Pure entrypoint exports                                                                            |
| `src/node/paths.ts`          | `GENAI_CONFIG_DIR`, `PROVIDERS_CONFIG_PATH`, enforced env-var name, lockfile path                  |
| `src/node/types.ts`          | Node seam option/result types (`LoadCatalogOptions`, `ProviderCatalogChange`, `Disposable`, …)     |
| `src/node/load-config.ts`    | `loadProvidersConfig()` — read, validate, enforce, re-validate                                     |
| `src/node/build-catalog.ts`  | `buildCatalog()` — assemble `ResolvedProvider[]` from merged config + baseline + env overlay       |
| `src/node/load-catalog.ts`   | `loadResolvedProviderCatalog()` — public read seam                                                 |
| `src/node/mutate-config.ts`  | `mutateProvidersConfig()` — locked, atomic, serialized mutation                                    |
| `src/node/watch-catalog.ts`  | `watchResolvedProviderCatalog()` — watch, reload, diff, emit typed changes                         |
| `src/node/index.ts`          | Node entrypoint; re-exports pure entry + filesystem seams                                          |
| `providers.schema.json`      | Generated JSON Schema, exported for editor validation                                              |
| `scripts/generate-schema.ts` | Regenerates `providers.schema.json` from the Zod schemas                                           |

## Invariants & Design Decisions

- **Three entrypoints, clean boundaries**: pure logic (schema, vocabulary,
  resolution) stays free of Node FS APIs so it runs in the browser and tests;
  only `ai-config/node` touches the filesystem, and only `ai-config/positron`
  imports `vscode`.
- **No import edge to the bridge or credential store** — vocabulary
  compatibility is guaranteed by the shape guard instead.
- **Graceful degradation everywhere on the read path** — a malformed or missing
  file never throws; it logs and falls back.
- **`CustomProviderId` is branded** and only mintable through
  `mintCustomProviderId()`, after collision checks.
- **External builds** pass `external: true` to `buildCatalog()`, which skips
  `providers.custom` entries (the bundler aliases non-positai client code away,
  so custom providers would have no runtime client).
- **Cross-process write safety** is owned entirely inside `mutateProvidersConfig`
  (lockfile + serialization queue + atomic write); callers just supply a mutator.
