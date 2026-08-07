---
title: ai-config Architecture
description: Architecture of ai-config -- the providers.json schema, the load -> enforce -> build -> watch resolution pipeline, and the file I/O seams.
package: ai-config
---

# ai-config Architecture

## Overview

`ai-config` owns the full lifecycle of `~/.posit/ai/providers.json`: the
schema, validation, defaults, the resolution pipeline that turns a raw file into
an effective provider catalog, and the filesystem seams that load, watch, and
mutate the file safely across processes.

It is a dependency-light leaf: it does **not** import `ai-provider-bridge`,
`ai-credentials`, or `vscode`. Compatibility with the bridge's vocabulary is
enforced at compile time by a shape guard (see [Shape Guard](#shape-guard)),
not by an import edge.

The richer consumer-facing narrative of how this config drives provider
enablement in Posit Assistant lives in the main monorepo's
`memory-bank/providerConfigFile.md`. This document covers the package itself.

## Entrypoints

The package has two code entrypoints, splitting pure (browser/test-safe) logic
from filesystem I/O:

| Entrypoint                        | What it exports                                                                                                                                                                                                                                                                                            | External deps? |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `ai-config`                       | Vocabulary, Zod schemas, inferred types, defaults, the pure resolution helpers (`resolveModels`, `mergeEnforced`), bare-host base URL correction (`normalizeBaseUrlForProvider` + host constants), the legacy Positron settings map/translator, and the model capability tables + `inferModelCapabilities` | No             |
| `ai-config/node`                  | Re-exports the pure entry plus the three filesystem seams (`loadResolvedProviderCatalog`, `mutateProvidersConfig`, `watchResolvedProviderCatalog`) and path constants                                                                                                                                      | Node FS        |
| `ai-config/providers.schema.json` | The generated JSON Schema, exported so editors can validate/autocomplete `providers.json`                                                                                                                                                                                                                  | No             |

Legacy Positron settings reach the loader through two independent options —
`legacyPositronSettings` (a two-method injected reader for the user-set
channel) and `legacyPositronEnforcedSettings` (a boolean for the
`POSITRON_ENFORCED_SETTINGS` admin channel) — so no entry imports `vscode` and
the map/translator live inside ai-config (see [Legacy Positron settings](#legacy-positron-settings-provider-settings-migration)).

### Pure entry (`ai-config`)

- **Vocabulary** (`src/vocabulary.ts`): `BUILTIN_PROVIDER_IDS`, `CLIENT_KIND_VALUES`, `PROTOCOL_VALUES`, `RESERVED_PROVIDER_KEYS`, `isBuiltinProviderId()`, and the `BuiltinProviderId` / `ClientKind` / `Protocol` / `ReservedProviderKey` types.
- **Schemas** (`src/schema.ts`): `providersConfigSchema` (full, strict) and `providersConfigFragmentSchema` (relaxed — custom-entry `type` optional; the fragment shape every catalog config source carries).
- **Types** (`src/types.ts`): types inferred from the Zod schemas (`ProvidersConfig`, `ProvidersMap`, `BuiltinProviderBlock`, `CustomProviderEntry`, `ModelsBlock`, `ModelOverride`, `CustomModel`, …) plus resolution outputs (`ResolvedProvider`, `ResolvedConnection`, `ResolvedConnectionProvenance`, `ResolvedModelInfo`) and the branded `CustomProviderId`. `mintCustomProviderId()` is the **only** way to produce a `CustomProviderId`.
- **Defaults** (`src/defaults.ts`): per-provider connection defaults and the `PROVIDER_CONNECTION_DEFAULTS` map. **Bedrock deliberately carries no entry**: `BEDROCK_DEFAULTS` (`us-east-1`) is exported but absent from `PROVIDER_CONNECTION_DEFAULTS`, because layering it into the resolved connection made the baked-in default outrank a user's stored credential region downstream (posit-dev/assistant#2002). Consumers apply the fallback at credential-synthesis time instead; do not "fix" the omission by adding Bedrock to the defaults map.
- **Resolution helpers**: `resolveModels()` and `mergeEnforced()` are pure and exported; `resolveEnabled()` / connection resolution are internal helpers used by the catalog builder.
- **Config-source contracts** (`src/config-source.ts`): `ProviderConfigSource` (public — the resolver's input) and the internal `ProviderConfigSourceProvider` (loader machinery, not exported). `Disposable` stays public as the return type of `LegacySettingsReader.watch`.
- **Constant**: `PROVIDERS_CONFIG_VERSION = 1` — the on-disk format version.

### Node entry (`ai-config/node`)

Re-exports the pure entry, plus:

- **Paths**: `AI_CONFIG_DIR` (`~/.posit/ai`) and `PROVIDERS_CONFIG_PATH`.
- **Read seam**: `loadResolvedProviderCatalog(opts)` — the single read entry point.
- **Write seam**: `mutateProvidersConfig(mutator, opts)` — cross-process-safe mutation.
- **Watch seam**: `watchResolvedProviderCatalog(handler, opts)` — emits typed `ProviderCatalogChange` events.
- **Types**: `LoadCatalogOptions` (including the transitional `legacyPositronSettings` / `legacyPositronEnforcedSettings` options), `MutateConfigOptions`, `WatchCatalogOptions`, `ProviderCatalogChange`, `LoggerLike`, `Disposable`.

## Schema Structure (`src/schema.ts`)

The `providers` map is tightened along two axes so a block rejects connection
sub-sections that don't apply to it — in both the Zod schema and the generated
JSON Schema:

- **Built-in providers are per-key, not a union.** Each built-in id
  (`providers.anthropic`, `providers.bedrock`, …) is a distinct object key, and
  the key **is** the discriminator (built-in blocks carry **no `type` field** —
  the client kind comes from the bridge registry). Each key gets its own
  tailored strict block via `connectionBlockSchema(sections)`, composed from
  `baseConnectionFields` + only the capability sub-sections that provider
  carries.
- **Custom providers are a genuine discriminated union** on `type`
  (`z.discriminatedUnion("type", […])`), one variant per supported client kind,
  each carrying only its relevant sub-sections.

**Capability maps (single source of truth).** `BUILTIN_CONNECTION_SECTIONS`
(keyed by built-in id) and `CUSTOM_CONNECTION_SECTIONS` (keyed by supported
custom `type`) name which of `aws` / `googleCloud` / `snowflake` / `positaiLogin`
each provider carries. Both are `satisfies Record<…>` so a missing key is a
compile error (exhaustiveness). Only four built-ins carry a section — `bedrock`
(`aws`), `google-vertex` (`googleCloud`), `snowflake-cortex` (`snowflake`),
`positai` (`positaiLogin`); of the custom kinds only `aws` / `google-vertex` /
`snowflake` do. `positaiLogin` attaches to the built-in `positai` key **only** —
no custom variant carries it.

**Supported custom kinds ⊂ client kinds.** `providers.custom` entries are
restricted to `SUPPORTED_CUSTOM_CLIENT_KIND_VALUES` (9 kinds), a local mirror of
`ai-credentials/types`' list (no import edge; kept equal by the shape guard).
Product-specific kinds (`positai`, `anthropic`, `openai`, `gemini`, `copilot`)
are **excluded** — a custom provider proxying those APIs uses
`openai-compatible`. An unsupported `type` is now an upfront schema error rather
than a silent catalog-time drop.

**`positaiLogin` (formerly `oauth`).** The Posit-login connection sub-section
was renamed from `oauth` to `positaiLogin` — it is Posit-login-specific config
(the engine hard-codes Posit's device-auth/token URL conventions around the bare
`host`), not generic OAuth. The rename spans the disk field, the runtime
`ResolvedConnection.positaiLogin`, `POSIT_AI_DEFAULTS.positaiLogin`, and the env
overlay. It does **not** touch the auth-method / storage-key / status vocabulary,
which stays `oauth` (a genuinely different concept — mapped at the
`getPositaiAuthConfig` seam in `@assistant/node`).

**Strict validation vs. permissive working type.** Strictness is a parse-time
property. The inferred `ProvidersMap` built-in blocks and `ResolvedConnection`
stay a permissive **superset** (all sub-sections optional), so reader/writer code
(`resolveConnectionFromBlock`, `authentication-fragment.ts`) is union-agnostic.
The **enforced** schemas stay loose too: built-in keys use the superset block and
custom `type` is optional (though still constrained to the supported 9 when
present) — a discriminated union requires its discriminator, so full validation
runs on the **merged** result, and `recoverValidStack()` drops any relaxed
overlay that becomes invalid after merge.

## Resolution Pipeline

Config flows through three stages: **assemble sources → resolve → watch**. Precedence lives entirely inside the pure `resolveProviderCatalog({ sources })` seam (`src/resolve-catalog.ts`); the node entry only assembles sources.

1. **Assemble sources** (`src/node/load-config.ts`): read the file (missing → `{}`,
   validated against `providersConfigSchema`), the enforced fragment from
   `POSIT_AI_PROVIDERS_ENFORCED`, and the defaults fragment from
   `POSIT_AI_PROVIDERS_DEFAULT` (both validated against the relaxed
   `providersConfigFragmentSchema`), plus the legacy Positron layers the
   loader opted into (`legacyPositronSettings` → `legacy-positron`,
   `legacyPositronEnforcedSettings` → `legacy-positron-enforced`). Each
   becomes a `ProviderConfigSource` tagged with its `kind` (`enforced` /
   `legacy-positron-enforced` / `user` / `legacy-positron` / `default`).
2. **Resolve** (`src/resolve-catalog.ts`, `resolveProviderCatalog()`): rank the
   sources by kind (`enforced` > `legacy-positron-enforced` > `user` >
   `legacy-positron` > `default`), fold them low → high so the sealed `enforced`
   overlay can never be overwritten, apply the `PlatformBaseline` beneath, and
   build `ResolvedProvider[]` via `build-catalog.ts`. Objects deep-merge per
   leaf-key (`mergeConfigFragments`), `allow`/`deny` arrays wholesale-replace.
   Connection env vars are a resolver-owned source ranked below `enforced` and
   `legacy-positron-enforced` but above `user`/`legacy-positron`/`default` — not
   a post-resolution overlay. The resolver also retains narrow semantic
   provenance for connection values whose source changes consumer behavior.
   `loadResolvedProviderCatalog()`
   (`src/node/load-catalog.ts`) is the public read seam that composes assembly +
   resolve and returns `readonly ResolvedProvider[]`. (`mergeEnforced` — the
   two-layer merge — remains exported as a low-level primitive, but the layered
   resolver is the seam consumers should use.)
3. **Watch** (`src/node/watch-catalog.ts`, `watchResolvedProviderCatalog()`):
   source-aware — watches the file via `fs.watch` and subscribes to the legacy
   reader's change signal; **any** source change re-resolves the catalog and
   emits a typed `ProviderCatalogChange` when a resolved value or its retained
   connection provenance actually changed.

### Connection provenance

`ResolvedProvider.connectionProvenance` is deliberately separate from runtime
`connection` values so consumers cannot accidentally spread metadata into SDK
options. It currently records the semantic origin of Bedrock's effective
`aws.region`: `environment` means ambient `AWS_REGION` is the only source of
that value, while `configuration` means a user, legacy, admin, or default source
also deliberately declares it. An equal explicit value therefore remains
distinguishable from ambient-only state. This lets auth-readiness policy stay
conservative without forcing consumers to reconstruct ai-config's precedence
stack.

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
- **Connection**: enforced > legacy-positron-enforced > connection env vars >
  user file > legacy-positron (legacy Positron settings via the
  `legacyPositronSettings` reader) > built-in defaults. Object keys deep-merge
  across layers.
- **Model protocol**: user config (override/custom) > provider protocol >
  discovered model inference.
- **Model endpoint**: model override/custom model > provider
  `endpoints[resolvedProtocol]` > discovered model `baseUrl` > provider-wide
  `baseUrl` > client default.

## Legacy Positron settings (PROVIDER-SETTINGS-MIGRATION)

`src/legacy-positron-settings/` is the fenced migration-window module — every
piece is tagged `PROVIDER-SETTINGS-MIGRATION(legacy-positron)` and deletes
together when the legacy channels retire.

- **`map.ts`** — the single source of truth for the legacy Positron settings →
  providers.json map: connection rows (`authentication.<configKey>.*` →
  provider blocks, including the runtime-only `github` → `copilot` row and the
  migration-only `googleVertex` row), credential-section keys (aws / snowflake
  / googleVertex / databricks), enablement rows (old
  `positron.assistant.provider.*.enable` and new `assistant.provider.*.enabled`
  generations; new wins), and model-override rows
  (`positron.assistant.models.overrides.*`). `legacySettingKeys()` lists every
  key the map consumes (Positron's migration uses it as its
  something-to-migrate check).
- **`translate.ts`** — `translateLegacyPositronSettings(reader, logger?,
warnedKeys?)`: the pure translator from a `LegacySettingsReader` (`get` +
  required `watch`) to `{ config, migrations }`. Omit-empty everywhere; per-key
  shape validation with warn-once drop; bare-host base URL correction applied
  internally via `normalizeBaseUrlForProvider`; model overrides synthesized
  into full custom models with `inferModelCapabilities` (user token limits
  win; `maxContextLength` floors at the user's `maxInputTokens`); `migrations`
  records `{ source, destination, value }` per written value with header
  values redacted to names. Shared verbatim by the runtime layers and
  Positron's one-shot migration.
- **`sources.ts`** — internal (never exported from the entries) builders for
  the two runtime layers, assembled by both the load and watch seams from the
  loader options — each layer is an independent opt-in: `legacy-positron`
  (reader-backed, watchable, below `user`) requires the
  `legacyPositronSettings` reader; `legacy-positron-enforced` (the
  `POSITRON_ENFORCED_SETTINGS` env payload, payload-only reads, above `user`,
  below `enforced`) requires `legacyPositronEnforcedSettings: true`. Neither
  option means neither layer, even if the env var is set; the reader never
  smuggles the enforced layer in.

The two layers split because Positron ≥ 2026.08 migrates legacy settings into
providers.json without clearing them (old builds and settings sync still read
the legacy channel), so keeping the `legacy-positron` fallback there means a
cleared providers.json value silently resurrects its stale legacy source.
Migrated hosts therefore pass only `legacyPositronEnforcedSettings: true`
(admin enforcement keeps working); the assistant extension passes the reader
only on pre-migration Positron (< 2026.08). Retiring either layer later is
loader-internal (zero consumer edits; expected trigger
posit-dev/positron#14709).

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

## Model Capability Inference (`src/model-capabilities/`)

`ai-config` also owns the shared model-metadata charter: per-provider capability
tables and `inferModelCapabilities(providerId, modelId)`, the single function
that turns a bare provider + model id into a complete capability set. This
moved here from `ai-provider-bridge` (ai-lib#9) so any `ai-config` consumer —
Positron's authentication extension, the assistant, future core — can
synthesize model capabilities without taking the bridge's dependency tree
(SDKs, `vscode` peer, etc.). The bridge re-exports the helpers it used to own
(`getAnthropicModelCapabilities`, `getGeminiModelCapabilities`,
`getOpenAIModelCapabilities`, `openaiMaxInputTokens`,
`getPositAiModelCapabilities`) from `ai-config` so none of its existing
consumers broke; its own `getGeminiInteractionsProfile` /
`isInteractionsEligible` stayed behind as `gemini-interactions.ts`, since that
allowlist is bridge SDK-routing logic (which wire API `GeminiClient` speaks),
not a dependency-free capability table.

**The tables** (`anthropic-helpers.ts`, `deepseek-helpers.ts`,
`gemini-helpers.ts`, `gemma-helpers.ts`, `openai-helpers.ts`) are pure
regex-driven lookups from a provider-specific model id to a partial capability
set — no imports beyond `InferredModelCapabilities` (a projection of
`ModelInfoLike` with identity/routing fields dropped and `protocol` narrowed to
the canonical `Protocol` union). `positai-helpers.ts` composes the Anthropic
and Gemma tables, since Posit AI routes both families.

**`inferModelCapabilities(providerId, modelId)`** (`src/model-capabilities/infer.ts`)
merges a conservative `GENERIC_BASELINE` (128k context, tools on, no images,
no web search) under provider-family inference, with inference winning per
field.

The policy for every provider case: mirror the static caps the bridge's
provider builder declares for that provider. Where a builder derives values
from live API responses (e.g. Vertex token limits), inference approximates
with the family table and keeps feature flags conservative — understating a
capability degrades gracefully, overstating it breaks requests.

Per-provider cases:

- `anthropic` → the Anthropic table.
- `bedrock` → the Mantle OpenAI-family table first, then the Anthropic table.
  The Mantle rules deliberately exclude safeguard and unknown IDs; gpt-oss
  uses Chat Completions while GPT-5.x uses Responses.
- `openai` → the OpenAI table, with `maxInputTokens` re-derived via
  `openaiMaxInputTokens()` (context window minus reserved output budget) —
  the table itself doesn't set it.
- `positai` → the combined Anthropic/Gemma lookup.
- `gemini` → the Gemini table.
- `deepseek` → the DeepSeek table, mapped specially: DeepSeek publishes no
  separate context-window figure, so `maxContextLength` is set equal to the
  table's `maxInputTokens` (mirroring how `deepseek-provider.ts` in the bridge
  already treats the input limit as the window).
- `google-vertex` → strips Vertex resource prefixes
  (`publishers/<publisher>/models/...`), then routes Gemini ids to the Gemini
  table and Anthropic partner ids to the Anthropic table (mirroring
  `google-vertex-provider.ts`; the builder's live-API token limits match the
  Gemini table's 1M/65k values).
- `snowflake-cortex` → Snowflake serves a fixed catalog with its own caps, so
  inference applies them rather than the upstream model limits: Claude ids get
  the Anthropic Messages API shape (200k context / 16,384 output, tool-result
  images on); anything else strips a leading `openai-` prefix, consults the
  OpenAI table, and gets the Chat Completions shape (128k / 16,384,
  tool-result images off, image support only when the upstream table lists
  image media types). Only `family` and `thinkingEffortLevels` are borrowed
  from the upstream tables (mirroring `snowflake-cortex-provider.ts`). Both
  branches set `protocol` (`"anthropic-messages"` or `"openai-chat"`).
- Protocol inference is intentionally limited to Snowflake and Bedrock Mantle;
  other provider families leave it `undefined`.
- Anything else (`ms-foundry`, `openai-compatible`, custom provider ids) stays
  at the generic baseline — those are unknown endpoints.

One derivation sits above the per-family lookup: the Anthropic and Gemini
tables list `supportedInputMediaTypes` (image MIME types) but never set
`supportsImages` directly, so `inferProviderDefaults()` lifts `supportsImages`
to `true` whenever a table leaves it unset AND lists an `image/*` media type —
otherwise the baseline `false` would win for models that plainly accept
images. A table's explicit value (e.g. GPT-3.5's `supportsImages: false`) is
never overridden.

`inferModelCapabilities` is the intended delegation target for
posit-dev/positron#14708 Task 8 and for the assistant's
`model-override.ts` (its `GENERIC_BASELINE` + inference chain is mirrored
here, with three improvements over that copy: the `openai` case now derives
`maxInputTokens` instead of leaving the 128k baseline, a `deepseek` case uses
the DeepSeek table, and `supportsImages` is derived from media types as
described above).

## Shape Guard

`typechecks/shape-guard.typecheck.ts` holds compile-time assertions (type-checked
on every build, never emitted) that keep `ai-config`'s vocabulary compatible with
`ai-provider-bridge` **without an import edge**:

- `BUILTIN_PROVIDER_IDS` exactly matches the bridge's `PROVIDER_IDS`.
- Model-override metadata field names are a subset of the bridge's `ModelInfo` keys.
- `PROTOCOL_VALUES` is a subset of the bridge's `Protocol`.
- `CLIENT_KIND_VALUES` maps onto provider IDs, allowing for the non-identity
  mappings (`aws` → `bedrock`, `snowflake` → `snowflake-cortex`).
- `ai-config`'s `SUPPORTED_CUSTOM_CLIENT_KIND_VALUES` **equals**
  `ai-credentials/types`' list (the schema's custom discriminated union and the
  credential resolver must offer the same set of custom `type` values). The guard
  also asserts that list ⊆ `CLIENT_KIND_VALUES`.

One legacy assertion lives as a **runtime** test instead:
`ai-provider-bridge/src/__tests__/legacy-map-guard.test.ts` pins ai-config's
`LEGACY_CONNECTION_ROWS` against the derivation from `PROVIDER_MAP` +
`CONFIG_KEY_OVERRIDES` (every `apikey` provider except the snowflake/databricks
special cases, with `googleVertex` → `google-vertex` as the one declared
extra). `PROVIDER_MAP`'s declared type is deliberately non-literal, so this
cannot be a compile-time guard.

If the bridge adds a provider, the guard fails until `ai-config` is updated, and
vice versa. `ai-config` types like `ModelInfoLike` are satisfied structurally by
the bridge's `ModelInfo` — compatible by contract, not by import.

## Code Layout

| Location                              | What it does                                                                                                        |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/vocabulary.ts`                   | Provider-ID / protocol / client-kind / reserved-key value tuples + type guards                                      |
| `src/schema.ts`                       | Zod schemas (full + enforced variants) for `providers.json`                                                         |
| `src/types.ts`                        | Types inferred from Zod + resolution outputs + branded `CustomProviderId` / `mintCustomProviderId`                  |
| `src/defaults.ts`                     | Built-in provider connection defaults; `PROVIDER_CONNECTION_DEFAULTS`                                               |
| `src/enforce.ts`                      | `mergeEnforced()` deep-merge of enforced over user config                                                           |
| `src/resolve-enabled.ts`              | `resolveEnabled()` enablement precedence ladder                                                                     |
| `src/resolve-connection.ts`           | Internal baseUrl/endpoint resolution precedence                                                                     |
| `src/resolve-models.ts`               | `resolveModels()` model selection + routing pipeline                                                                |
| `src/model-capabilities/*-helpers.ts` | Per-provider capability tables (moved from the bridge, ai-lib#9)                                                    |
| `src/model-capabilities/infer.ts`     | `inferModelCapabilities()` — baseline + provider-family merge, Snowflake protocol rule                              |
| `src/index.ts`                        | Pure entrypoint exports                                                                                             |
| `src/node/paths.ts`                   | `AI_CONFIG_DIR`, `PROVIDERS_CONFIG_PATH`, enforced env-var name, lockfile path                                      |
| `src/node/types.ts`                   | Node seam option/result types (`LoadCatalogOptions`, `ProviderCatalogChange`, `Disposable`, …)                      |
| `src/resolve-catalog.ts`              | `resolveProviderCatalog()` — pure deep resolver seam; owns the precedence stack + sealed-enforced invariant         |
| `src/base-url.ts`                     | `normalizeBaseUrlForProvider()` + known host/version constants (the bridge imports them from here)                  |
| `src/config-source.ts`                | `ProviderConfigSource` + internal `ProviderConfigSourceProvider` loader machinery                                   |
| `src/legacy-positron-settings/`       | PROVIDER-SETTINGS-MIGRATION: legacy settings map, translator, and internal source builders                          |
| `src/build-catalog.ts`                | `buildCatalog()` — assemble `ResolvedProvider[]` from merged config + enablement layers + baseline (pure entry)     |
| `src/node/load-config.ts`             | `loadConfigSources()` / `readFileConfig()` / `readEnvFragment()` — assemble the ordered `ProviderConfigSource` list |
| `src/node/load-catalog.ts`            | `loadResolvedProviderCatalog()` — public read seam (assemble sources → `resolveProviderCatalog`)                    |
| `src/node/mutate-config.ts`           | `mutateProvidersConfig()` — locked, atomic, serialized mutation                                                     |
| `src/node/watch-catalog.ts`           | `watchResolvedProviderCatalog()` — watch, reload, diff, emit typed changes                                          |
| `src/node/index.ts`                   | Node entrypoint; re-exports pure entry + filesystem seams                                                           |
| `providers.schema.json`               | Generated JSON Schema, exported for editor validation                                                               |
| `scripts/generate-schema.ts`          | Regenerates `providers.schema.json` from the Zod schemas                                                            |

## Invariants & Design Decisions

- **Two entrypoints, clean boundaries**: pure logic (schema, vocabulary,
  resolution, the legacy settings translator) stays free of Node FS APIs so it
  runs in the browser and tests; only `ai-config/node` touches the filesystem.
  Nothing imports `vscode` — hosts inject a `LegacySettingsReader` instead.
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
