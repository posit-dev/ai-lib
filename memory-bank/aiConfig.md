---
title: ai-config Architecture
description: Architecture of ai-config -- the providers.json schema, the load -> enforce -> build -> watch resolution pipeline, and the file I/O seams.
package: ai-config
---

# ai-config Architecture

## Overview

`ai-config` owns the full lifecycle of `~/.posit/ai/providers.json`: its JSONC
parsing, schema validation, defaults, the resolution pipeline that turns a raw file into
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

The package has three code entrypoints, splitting pure (browser/test-safe) logic,
JSONC transformation, and filesystem I/O:

| Entrypoint                        | What it exports                                                                                                                                                                                                                                      | External deps?         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `ai-config`                       | Vocabulary, schemas/types/defaults, `salvageProvidersConfig`, structured config issues, the pure report resolver (`resolveProviderCatalogReport` plus compatibility wrapper), resolution helpers, legacy translation, and model capability inference | `zod`                  |
| `ai-config/jsonc`                 | Pure validation-free JSONC diff-to-edits transformation and JSON serialization normalization                                                                                                                                                         | `jsonc-parser`         |
| `ai-config/node`                  | Re-exports the pure entry plus `loadProviderCatalogReport` / `loadResolvedProviderCatalog`, the strict raw user custom-entry reader, strict mutation, issue-aware watching, and path constants                                                       | Node FS + package deps |
| `ai-config/providers.schema.json` | The generated JSON Schema, exported so editors can validate/autocomplete `providers.json`                                                                                                                                                            | No                     |

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
- **Structured diagnostics** (`src/config-issue.ts`): `ConfigIssue` is source-agnostic; `SourcedConfigIssue` adds a required normalized `{ kind, label }` identity. Its source kind reuses `ProviderConfigSourceKind` and widens only for the resolver-private `"env"` source.
- **Tolerant validation** (`src/salvage-config.ts`): `salvageProvidersConfig()` takes the healthy full-schema fast path, otherwise drops malformed values at whole root/provider/custom-entry granularity and seals the reconstruction with `providersConfigSchema` before returning.
- **Constant**: `PROVIDERS_CONFIG_VERSION = 1` — the on-disk format version.

### JSONC entry (`ai-config/jsonc`)

- **JSONC transformer** (`src/edit-jsonc.ts`): `editJsonc(originalText, intendedValue)` is a pure,
  validation-policy-free diff-to-edits seam shared by provider and application settings writers.
  It normalizes the intended value through a JSON serialization round trip, rejects touched
  duplicate-key paths, applies maximal changed subtrees sequentially, and preserves unrelated
  comments and formatting. `normalizeJsonValue()` exposes the exact normalization step to callers
  that must verify a domain-validated persisted shape. Keeping this dependency behind a focused
  subpath prevents unrelated `ai-config` consumers from bundling `jsonc-parser`.

### Node entry (`ai-config/node`)

Re-exports the pure entry, plus:

- **Paths**: `AI_CONFIG_DIR` (`~/.posit/ai`) and `PROVIDERS_CONFIG_PATH`.
- **Read seams**: `loadProviderCatalogReport(opts)` is the canonical report-first entry point;
  `loadResolvedProviderCatalog(opts)` is its bare-catalog compatibility wrapper.
  `readUserCustomProviderEntry(providerId, opts)` is the intentionally narrow edit seam: it
  returns one full custom entry exactly as authored in the user file, before overlays or
  derivation. A missing file/entry returns `undefined`; a non-custom id raises
  `NonCustomProviderIdError`; a present invalid or unreadable file rejects under strict mutation
  discipline rather than being salvaged. It stays on the Node entry because the full raw entry
  may include advanced fields that must be preserved server-side and never projected to a browser.
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
restricted to `SUPPORTED_CUSTOM_CLIENT_KIND_VALUES`, a local mirror of
`ai-credentials/types`' list (no import edge; kept equal by the shape guard).
Custom `anthropic`, `openai`, and `gemini` are supported base-only variants and
use required API-key auth. Product-bound kinds (`positai`, `copilot`, and
`databricks`) are **excluded** because their login flows cannot be represented
by generic custom-provider auth. An unsupported `type` is now an upfront schema
error rather than a silent catalog-time drop. `portkey` is a supported base-only variant: it
accepts the shared connection/model fields but none of the provider-specific
`aws`, `googleCloud`, `snowflake`, `databricks`, or `positaiLogin` sections.

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
custom `type` is optional (though still constrained to the supported kinds when
present) — a discriminated union requires its discriminator, so full validation
runs on the **merged** result, and `recoverValidStack()` drops any relaxed
overlay that becomes invalid after merge.

## Resolution Pipeline

Config flows through three stages: **assemble sources → resolve → watch**. Precedence lives entirely inside the pure `resolveProviderCatalog({ sources })` seam (`src/resolve-catalog.ts`); the node entry only assembles sources.

1. **Assemble sources** (`src/node/load-config.ts`): read the user-editable file as JSONC
   (comments and trailing commas accepted; missing → `{}`; malformed blocks
   salvaged tolerantly into a full-schema-valid source), the enforced fragment from
   `POSIT_AI_PROVIDERS_ENFORCED`, and the defaults fragment from
   `POSIT_AI_PROVIDERS_DEFAULT` (both remain strict JSON and are validated against the relaxed
   `providersConfigFragmentSchema`), plus the legacy Positron layers the
   loader opted into (`legacyPositronSettings` → `legacy-positron`,
   `legacyPositronEnforcedSettings` → `legacy-positron-enforced`). Each
   reader returns `{ source?, issues }`; present sources are tagged with their
   `kind` (`enforced` / `legacy-positron-enforced` / `user` /
   `legacy-positron` / `default`).
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
   `loadProviderCatalogReport()` (`src/node/load-catalog.ts`) is the canonical
   public read seam and returns `{ catalog, issues }`; `loadResolvedProviderCatalog()`
   is its bare-catalog compatibility wrapper. (`mergeEnforced` — the
   two-layer merge — remains exported as a low-level primitive, but the layered
   resolver is the seam consumers should use.)
3. **Watch** (`src/node/watch-catalog.ts`, `watchResolvedProviderCatalog()`):
   source-aware — watches the file via `fs.watch` and subscribes to the legacy
   reader's change signal; **any** source change re-resolves the catalog and
   emits a typed `ProviderCatalogChange` when a resolved value, retained
   connection provenance, or complete issue snapshot changes. Issue snapshots
   compare order-insensitively by source/path/severity/message, so issue-only
   additions and empty clears emit while identical rebuilds remain quiet.

### Read salvage and report invariant

User-file reads are deliberately tolerant, while mutations are deliberately strict. The tolerant
parser shares JSONC syntax parsing with the strict parser, then calls `salvageProvidersConfig`.
Unknown root/provider keys, wrong-typed `$schema`, invalid built-in blocks, and invalid custom
entries are dropped one whole block at a time with one issue; valid siblings survive. Non-object
roots/providers and unsupported versions degrade to `{}` because their semantics are not safe to
reconstruct. The final full-schema parse is a runtime seal: downstream recovery may rely on the
user source being valid alone. A seal failure degrades to `{}` with an error issue rather than
throwing.

Every source reader returns the same `{ source?, issues }` report and never logs. Env fragments
remain strict and all-or-nothing. Internal legacy Positron providers report their current invalid
keys on every read (including recurrence after a fix); the exported
`translateLegacyPositronSettings(reader, logger?, warnedKeys?)` compatibility function retains its
historical warn-once behavior. `resolveProviderCatalogReport` is silent and carries overlay-drop
issues; `resolveProviderCatalog` renders those issues for compatibility. The one-shot node load
renders its complete report once, while the watcher renders only newly added/changed issues after
snapshot comparison.

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
warnedKeys?)`: the compatibility translator from a `LegacySettingsReader` (`get` +
  required `watch`) to `{ config, migrations }`. Omit-empty everywhere; per-key
  shape validation with warn-once drop; bare-host base URL correction applied
  internally via `normalizeBaseUrlForProvider`; model overrides synthesized
  into full custom models with `inferModelCapabilities` (user token limits
  win; `maxContextLength` floors at the user's `maxInputTokens`); `migrations`
  records `{ source, destination, value }` per written value with header
  values redacted to names. The internal report sibling applies the same map
  silently and returns current per-key issues for source snapshots.
- **`sources.ts`** — internal (never exported from the entries) builders for
  the two runtime layers, assembled by both the load and watch seams from the
  loader options — each layer is an independent opt-in: `legacy-positron`
  (reader-backed, watchable, below `user`) requires the
  `legacyPositronSettings` reader; `legacy-positron-enforced` (the
  `POSITRON_ENFORCED_SETTINGS` env payload, payload-only reads, above `user`,
  below `enforced`) requires `legacyPositronEnforcedSettings: true`. Neither
  option means neither layer, even if the env var is set; the reader never
  smuggles the enforced layer in. Each `read()` returns `{ source?, issues }`
  without logging or process-lifetime deduplication.

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

- **Load** splits syntax parsing from schema policy. `parseProvidersConfigTolerant` parses JSONC
  then salvages blocks; syntax/fs failures become sourced issues and `{}`. Readers are silent;
  `loadProviderCatalogReport` renders the completed snapshot once. Severity policy: whole-source
  failures (user-file syntax/read errors, whole-file salvage degrades — non-object
  root/`providers` or unsupported `version` — env-fragment parse/validation failures, and
  malformed legacy enforced settings, resolver overlay drops from `recoverValidStack`) are
  error-severity with an **empty path** (the source was
  discarded whole; offending key paths stay in the message prose); per-key salvage drops are
  warnings with the dropped key's path. `ConfigIssue` is a discriminated union encoding this
  contract (the error branch's path is `readonly []`), and the whole-source shape is
  constructed only via `wholeSourceIssue` / `sourcedWholeSourceIssue` (`src/config-issue.ts`),
  so the error-with-a-path combination is unrepresentable. Hosts surface only error-severity
  issues in the UI; warning-severity drops are log-only because the file is shared across
  consumers with different provider vocabularies. `parseJsonc` reports syntax errors as
  1-based `line L, column C` (computed from the text, since `jsonc-parser` only carries offsets),
  and whole-source failure messages are source-agnostic (`Invalid JSONC: …`) so hosts compose the
  user-facing "Failed to load \<path\>" prefix from source identity.
- **Watch** (`src/node/watch-catalog.ts`) debounces ~300ms to coalesce rapid
  edits, is ancestor-aware (watches the nearest existing parent dir until the
  config dir appears), reloads + diffs catalog and issues, and emits a typed
  `ProviderCatalogChange` with category flags plus `issues`/`issuesChanged`.
  It logs only issue-set additions; clear-then-recur logs again. The initial load does not emit.
- **Mutate** (`src/node/mutate-config.ts`) takes cross-process safety seriously:
  a `proper-lockfile` lock (with retries and stale detection), an in-process
  serialization queue per config path, race-safe first-creation via the
  exclusive `wx` flag, atomic write (temp file + rename), seed-metadata
  injection (`$schema`, `version`) on first creation, and a best-effort copy of
  `providers.schema.json` alongside the config for editor validation. After
  ensuring the file exists, strict `parseProvidersConfig` makes every read,
  JSONC syntax, unknown key, or schema-validation failure abort without
  rewriting the file; validation errors name offending paths. Existing files are transformed by
  `editJsonc`: intended values first inherit the previous whole-file writer's exact
  `JSON.stringify` semantics, then only maximal changed paths are edited sequentially against the
  evolving text. Unrelated comments, indentation, and line endings survive. A write touching an
  ambiguous duplicate-key path rejects without fallback, and a same-object or value-identical
  mutator result performs no write. First creation remains a whole-file serialization because no
  user-authored text exists to preserve. The edited bytes are reparsed, schema-validated, and
  compared with the same normalized intended shape before the atomic rename.

The internal `src/node/parse-jsonc.ts` helper centralizes Node-side JSONC parsing through
the dependency-free, browser-safe `jsonc-parser` package. It materializes the parse tree
with null-prototype objects so raw keys such as `__proto__` survive unchanged for schema
validation rather than mutating an intermediate object's prototype. `parse-providers-config.ts`
exposes named internal siblings: strict `parseProvidersConfig` for mutation and tolerant
`parseProvidersConfigTolerant` for reads; both share `parseJsonc`, with no mode flag.
Both helpers are internal to `src/node/` and are not exported from either entrypoint. The
browser-safe `ai-config/jsonc` entry separately exports `editJsonc` and `normalizeJsonValue`
without adding filesystem imports or a JSONC runtime dependency to the main pure entry.
Machine-supplied environment fragments continue to use strict `JSON.parse`.

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
- `gemini` → the Gemini-API endpoint composition
  (`getGeminiApiModelCapabilities`, `gemini-api-helpers.ts`): hosted-Gemma
  rules (`gemma-4-*`: 256K context, 32K output, product levels `["off",
"high"]`, image+PDF input, tool-result images) layered over the shared
  Gemini-family table. The shared table (`gemini-helpers.ts`) deliberately
  rejects bare `gemma-*` IDs — it is also consumed by provider-agnostic core
  inference and VS Code LM discovery, where hosted-endpoint semantics don't
  apply. The Posit AI/vLLM Gemma contract stays in `gemma-helpers.ts`.
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

### Databricks Native Routing (`databricks-helpers.ts`, `gemini-generate-content.ts`)

Databricks fronts many vendors behind one workspace and exposes native
passthrough APIs (Anthropic Messages, OpenAI Responses, Gemini
generateContent) alongside the universal OpenAI-compatible chat surface, on
either of two surfaces (classic Model Serving or the Unity AI Gateway). Unlike
`inferModelCapabilities`, routing here is genuinely provider-specific enough
to need its own entry point, `inferDatabricksModelProfile(input)`
(`src/model-capabilities/databricks-helpers.ts`) — it is **not** routed
through `inferModelCapabilities(providerId, modelId)`. `ai-provider-bridge`'s
`databricks-provider.ts` is its only caller; the equivalent bridge-side helper
this replaced (`model-capabilities/databricks-helpers.ts` in the bridge) was
deleted.

The input is the endpoint **structure** for every configured served entity
(not just the first), plus `surface: "serving" | "gateway"` — the pinned
decision from `ensureSurface` (see `memory-bank/architecture.md`). The output
is a Databricks-specific profile:

```ts
type DatabricksModelProfile =
  | { excluded: true }
  | {
      excluded: false;
      protocol: Protocol;
      vendor: string;
      capabilities: CompleteInferredModelCapabilities;
    };
```

`vendor` rides explicitly in the profile rather than in the capability types,
which deliberately omit identity metadata (the LiteLLM profile's `family`
field is the precedent). `{ excluded: true }` is a first-class outcome, not a
bad stamp: on the gateway surface, an endpoint whose entities cannot all serve
any supported native, unified Responses, or chat route has no route at all and
must not be listed. Unified Responses and chat are independent fallbacks: every
entity need advertise only the selected route's `api_types` entry (and gateway
v2 support), not both.

Classification rules, in order:

- **Structural + identity + (on gateway) advertised-surface eligibility.**
  Provider type alone is never sufficient: a Claude model on a
  provisioned-throughput or custom endpoint (no `foundation_model`, no
  eligible `external_model`) is not native-eligible; OpenAI Responses
  requires a recognized compatible family (`gpt-5*`, `gpt-4o*`); an
  unrecognized identity falls back to chat. On the gateway surface, every
  aggregated entity must additionally advertise the exact native `api_types`
  string for the selected protocol (`NATIVE_API_TYPES`); missing or unknown
  `api_types` also falls back to chat.
- **Gemini family rule**: `google-generative` is stamped only when the
  thinking variant is positively reconstructable from the **endpoint name** —
  the only identity `ModelClientChatParams` carries at chat time — **and** the
  served entity's own identity resolves to the same variant. Hosted
  pay-per-token names (`databricks-gemini-2-5-pro`, …) qualify (there the
  foundation-model name _is_ the endpoint name, so the two agree trivially);
  arbitrarily-named external Gemini endpoints fall back to `openai-chat`, as
  does a Gemini-named endpoint fronting something else (a Vertex Llama) or a
  different Gemini variant than its name suggests — either would be stamped
  with the wrong wire mapping. This reconstruction is
  `getGeminiGenerateContentProfile` (`src/model-capabilities/gemini-generate-content.ts`),
  a shared helper the classifier and `GeminiGenerateContentClient` both call
  — the same function decides whether a model may be stamped
  `google-generative` and how to build the wire `thinkingConfig`, so the
  stamp and the wire choice cannot disagree. It normalizes bare Gemini ids,
  OpenRouter-style prefixes, and Databricks naming (both pay-per-token
  `databricks-gemini-2-5-pro` and Unity Catalog `system.ai.gemini-2-5-flash`)
  to one rule table, and returns a **variant-granular** profile — not just
  the coarse 2.5/3.x family — because validity differs within 2.5 itself (Pro
  cannot disable thinking; Flash/Flash-Lite can; budget ranges and defaults
  differ per tier) and 3.x variants differ in which `thinkingLevel` values
  they accept.
- **Multi-entity rules**: endpoints can traffic-split across served entities.
  Every _configured_ entity participates (`traffic_config` is deliberately
  not read — splits change independently of the configuration observed here);
  the native route requires every entity to resolve to the same protocol
  (mixed/empty/ambiguous prefers unified MLflow Responses when every entity
  advertises it, then falls back to `openai-chat` when chat is unanimously
  advertised); capabilities aggregate conservatively across
  same-protocol entities (minimum numeric limits, intersection of
  media-type/effort-level sets, boolean AND, `vendor`/`family` only when
  unanimous); and the whole computation is entity-order invariant.
- **Fallback stamps are always explicit**, never `undefined`: a gateway endpoint
  gets `mlflow-responses` when unanimously advertised, otherwise `openai-chat`
  wherever chat exists. `undefined` stays reserved for providers that made no
  routing decision at all.

**Two documented limitations, not fixed here:**

1. **Protocol-override capability staleness.** If a user overrides a model's
   protocol, the capabilities stay whatever was stamped for the _original_
   inferred protocol — `resolveModels` merges user capability overrides into
   the flat model object before `attachRouting`, so nothing downstream can
   tell a user-supplied capability value apart from an inferred one once
   merged, and no safe protocol-keyed mask can be built after that point.
   This is the same pre-existing limitation LiteLLM has, not a new one
   introduced for Databricks. A real fix needs a provenance/profile seam
   through the resolution pipeline and is tracked as follow-up work, not part
   of this feature.
2. **`vendor` scope.** The profile's `vendor` feeds bridge
   `ModelInfo.vendor` — a required field, consumed directly by Notebooks. The
   assistant monorepo overwrites `vendor` with the provider display name for
   _every_ provider (`NodeModelService.applyModelResolution`), so this
   profile's `vendor` never reaches assistant-side pricing/display logic
   today; preserving upstream vendor there is explicitly out of scope for
   this work and confined to `ai-lib`.

**Media types are masked on every route.** No Databricks route documents PDF
input: the OpenAI-compatible chat surface does not accept it, and the
[provider-native API matrix](https://docs.databricks.com/aws/en/machine-learning/model-serving/provider-native-apis)
documents native input as text + image for Anthropic Messages and OpenAI
Responses, and text + image + video + audio for Gemini generateContent. Both
the chat fallback and every native route therefore advertise the image set
only (`DATABRICKS_IMAGE_MEDIA_TYPES`), dropping the vendor tables'
`application/pdf`; Gemini's video/audio input is outside our capability
surface and is not advertised either.

**Hosted pay-per-token Responses endpoints advertise no thinking controls.**
Databricks documents `store` and `previous_response_id` as
[unsupported on pay-per-token foundation models](https://docs.databricks.com/aws/en/machine-learning/model-serving/query-openai-responses#limitations),
returning a 400 if specified, and our responses thinking mode sends
`store: false` plus an encrypted-reasoning round-trip whenever thinking is on.
External endpoints support the full Responses parameter set and keep the
table's levels.

**Non-native endpoints prefer the unified MLflow Responses API over chat
completions.** The gateway exposes `/ai-gateway/mlflow/v1/responses` alongside
`/ai-gateway/mlflow/v1/chat/completions`. It is a different API from the
`openai/v1/responses` **native passthrough**, which Databricks refuses for
models it does not proxy natively. Endpoints advertising the
`mlflow/v1/responses` api_type are therefore stamped `mlflow-responses`, which
routes to `{host}/ai-gateway/mlflow/v1` in the SDK's Responses mode. The chat
surface loses on all three counts that matter: it rejects `store`, rejects
`max_completion_tokens`, and streams reasoning as a `delta.content` block array
that the OpenAI chunk schema cannot represent (so reasoning is discarded),
while Responses accepts the same thinking controls and carries reasoning as
first-class items.

The stamp is **gateway-only**: classic serving has no unified Responses route
(`/serving-endpoints/responses` is native passthrough and refuses
non-passthrough models), so serving keeps `openai-chat`. The advertised
api_type is an exact gate — on a live workspace, every endpoint advertising it
answered 200 and the one that did not (`databricks-meta-llama-3-3-70b-instruct`)
answered 400.

Verified against a live gateway-enabled workspace: `"anthropic/v1/messages"` is
correct, and Anthropic Messages works on `/ai-gateway/anthropic/v1`,
`/serving-endpoints/anthropic/v1`, and the per-endpoint `ai_gateway_url` host
alike. Note that `api_types` itself is **undocumented** — it appears in
discovery responses but in neither the REST docs nor the SDK's
`FoundationModel` dataclass — so an observed roll-up is its only source of
truth.

Two constants remain flagged `PHASE0-VERIFY`, both because that workspace has no
endpoint that can exercise them: the OpenAI and Gemini gateway `api_types`
strings. Do **not** "correct" `openai/v1/responses` to the `mlflow/v1/responses`
seen in a roll-up — they are different APIs, and the same model answers 200 on
one and 400 on the other. Gemini's Bearer auth is effectively settled by
Databricks' own example, which passes a dummy `api_key` and supplies
`Authorization: Bearer` through `http_options`. A wrong guess degrades safely —
the native gate simply never passes, so those models stay on a working route
rather than a broken one.

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

| Location                              | What it does                                                                                                                                     |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/vocabulary.ts`                   | Provider-ID / protocol / client-kind / reserved-key value tuples + type guards                                                                   |
| `src/schema.ts`                       | Zod schemas (full + enforced variants) for `providers.json`                                                                                      |
| `src/types.ts`                        | Types inferred from Zod + resolution outputs + branded `CustomProviderId` / `mintCustomProviderId`                                               |
| `src/defaults.ts`                     | Built-in provider connection defaults; `PROVIDER_CONNECTION_DEFAULTS`                                                                            |
| `src/enforce.ts`                      | `mergeEnforced()` deep-merge of enforced over user config                                                                                        |
| `src/resolve-enabled.ts`              | `resolveEnabled()` enablement precedence ladder                                                                                                  |
| `src/resolve-connection.ts`           | Internal baseUrl/endpoint resolution precedence                                                                                                  |
| `src/resolve-models.ts`               | `resolveModels()` model selection + routing pipeline                                                                                             |
| `src/model-capabilities/*-helpers.ts` | Per-provider capability tables (moved from the bridge, ai-lib#9)                                                                                 |
| `src/model-capabilities/infer.ts`     | `inferModelCapabilities()` — baseline + provider-family merge, Snowflake protocol rule                                                           |
| `src/index.ts`                        | Pure entrypoint exports                                                                                                                          |
| `src/node/paths.ts`                   | `AI_CONFIG_DIR`, `PROVIDERS_CONFIG_PATH`, enforced env-var name, lockfile path                                                                   |
| `src/node/types.ts`                   | Node seam option/result types (`LoadCatalogOptions`, `ProviderCatalogChange`, `Disposable`, …)                                                   |
| `src/resolve-catalog.ts`              | `resolveProviderCatalog()` — pure deep resolver seam; owns the precedence stack + sealed-enforced invariant                                      |
| `src/base-url.ts`                     | Legacy bare-host correction plus `normalizeOpenRouterBaseUrl()` / `OPENROUTER_DEFAULT_BASE_URL`, shared by OpenRouter discovery, chat, and forms |
| `src/edit-jsonc.ts`                   | Pure validation-free JSONC diff-to-edits transformer + JSON serialization normalization                                                          |
| `src/config-source.ts`                | `ProviderConfigSource` + internal `ProviderConfigSourceProvider` loader machinery                                                                |
| `src/legacy-positron-settings/`       | PROVIDER-SETTINGS-MIGRATION: legacy settings map, translator, and internal source builders                                                       |
| `src/build-catalog.ts`                | `buildCatalog()` — assemble `ResolvedProvider[]` from merged config + enablement layers + baseline (pure entry)                                  |
| `src/node/load-config.ts`             | `loadConfigSourceReports()` / readers — silently assemble `{ source?, issues }` reports; compatibility wrapper renders and returns sources       |
| `src/node/parse-jsonc.ts`             | Internal JSONC parser; comments/trailing commas, null-prototype object materialization, `SyntaxError` on invalid input                           |
| `src/node/parse-providers-config.ts`  | Internal strict `parseProvidersConfig()` mutation seam + tolerant `parseProvidersConfigTolerant()` read seam                                     |
| `src/node/load-catalog.ts`            | Canonical `loadProviderCatalogReport()` seam + bare-catalog `loadResolvedProviderCatalog()` compatibility wrapper                                |
| `src/node/mutate-config.ts`           | `mutateProvidersConfig()` — locked, atomic, serialized mutation                                                                                  |
| `src/node/watch-catalog.ts`           | `watchResolvedProviderCatalog()` — watch, reload, diff, emit typed changes                                                                       |
| `src/node/index.ts`                   | Node entrypoint; re-exports pure entry + filesystem seams                                                                                        |
| `providers.schema.json`               | Generated JSON Schema, exported for editor validation                                                                                            |
| `scripts/generate-schema.ts`          | Regenerates `providers.schema.json` from the Zod schemas                                                                                         |

## Invariants & Design Decisions

- **Two entrypoints, clean boundaries**: pure logic (schema, vocabulary,
  resolution, the legacy settings translator) stays free of Node FS APIs so it
  runs in the browser and tests; only `ai-config/node` touches the filesystem.
  Nothing imports `vscode` — hosts inject a `LegacySettingsReader` instead.
- **No import edge to the bridge or credential store** — vocabulary
  compatibility is guaranteed by the shape guard instead.
- **Graceful degradation on load/watch reads** — a malformed or missing
  file never throws; silent readers return recoverable sources plus structured
  issues, and load/watch orchestrators own issue rendering.
- **Mutations never rewrite unreadable input** — filesystem, JSONC syntax, and
  schema-validation failures all reject before the mutator or writer runs.
- **Mutations preserve unrelated JSONC text** — path-local edits retain comments and formatting;
  touched duplicate keys reject, and value-identical results do not write.
- **`CustomProviderId` is branded** and only mintable through
  `mintCustomProviderId()`, after collision checks.
- **External builds** pass `external: true` to `buildCatalog()`, which skips
  `providers.custom` entries (the bundler aliases non-positai client code away,
  so custom providers would have no runtime client).
- **Cross-process write safety** is owned entirely inside `mutateProvidersConfig`
  (lockfile + serialization queue + atomic write); callers just supply a mutator.
