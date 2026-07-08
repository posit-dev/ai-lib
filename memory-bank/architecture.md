---
title: ai-provider-bridge Architecture
description: Architecture of ai-provider-bridge -- entrypoints, invariants, code layout, credential system, VS Code LM integration, and client-side token usage estimation for vscode.lm providers (e.g. Copilot) that report no usage.
package: ai-provider-bridge
---

# Package Architecture

## Overview

`ai-provider-bridge` is a platform-neutral package that owns the provider infrastructure: the plugin registry, model clients, provider registration modules, and credential access abstractions. It decouples LLM provider integration from both Node platform layers and the VS Code extension host.

## Entrypoints

| Entrypoint                              | What it exports                                                                                                                                                                                                                                                                      | vscode dependency? |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `ai-provider-bridge`                    | `ProviderRegistry`, `ModelClient` interface, `StepLogger` interface, `CredentialProvider` interface, `createCachedModelFetcher`, `PROVIDER_MAP`, `MAPPED_PROVIDER_IDS`                                                                                                               | No                 |
| `ai-provider-bridge/providers`          | `register*Provider()` functions (14), all model client classes, AI SDK helpers, `openai-compat-fetch`, provider test utilities                                                                                                                                                       | No                 |
| `ai-provider-bridge/positron`           | `VscodeLmClient`, `listVscodeLmModels()`, `fromAiMessages2()`, LM helpers, `isProviderId()`, `toProviderId()`, `CONFIG_KEY_OVERRIDES` (**no** `PositronCredentialProvider` — removed in Phase 7; the VS Code auth backend is `createPositronBackend` from `ai-credentials/positron`) | **Yes**            |
| `ai-provider-bridge/credential-shaping` | `shapeCredentials()`, `CredentialConfig`, `CONFIG_KEY_OVERRIDES` -- pure credential shaping, browser-safe (no vscode, AI SDK, or node builtins); consumed by Positron's renderer facade                                                                                              | No                 |

## Invariants

- Root entrypoint **must not** import `vscode`
- Root entrypoint **must not** import any consumer package
- `/positron` entrypoint may import `vscode`
- Consumer packages (host applications) depend on `ai-provider-bridge`, **never** the reverse

## Code Layout

| Location                                         | What it does                                                                                                                             | VS Code deps? |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `src/types.ts`                                   | `PROVIDER_IDS` tuple (14 internal-build IDs) and `ProviderId` type -- single source of truth for valid provider IDs                      | No            |
| `src/providers/`                                 | Provider registry, model fetchers, client factories (14 internal-build providers)                                                        | No            |
| `src/model-clients/`                             | Chat API clients (Anthropic, OpenAI, Gemini, Bedrock, Snowflake, Copilot SDK, DeepSeek, etc.) via AI SDK                                 | No            |
| `src/model-capabilities/`                        | Per-provider capability inference helpers (model ID to capabilities mapping)                                                             | No            |
| `src/provider-map.ts`                            | `PROVIDER_MAP` and `MAPPED_PROVIDER_IDS` -- maps logical provider IDs to Positron auth provider config                                   | No            |
| `src/credential-shaping.ts`                      | `shapeCredentials()` -- pure token-to-`ProviderCredentials` shaping over an injected `CredentialConfig`                                  | No            |
| `src/custom-headers.ts`                          | Header merging/filtering utilities for custom HTTP headers                                                                               | No            |
| `ai-credentials/src/positron/PositronBackend.ts` | `createPositronBackend` -- VS Code auth backend (in `ai-credentials`, not the bridge; replaces the removed `PositronCredentialProvider`) | **Yes**       |
| `src/positron/VscodeLmClient.ts`                 | `VscodeLmClient` -- `ModelClient` implementation wrapping `vscode.LanguageModelChat`                                                     | **Yes**       |
| `src/positron/vscode-lm-models.ts`               | `listVscodeLmModels()`, `toProviderId()`, `isProviderId()`, vendor-to-provider mapping                                                   | **Yes**       |
| `src/positron/message-formats.ts`                | `fromAiMessages2()` (AI SDK to VS Code direction), cache control helpers                                                                 | **Yes**       |
| `src/positron/lm-helpers.ts`                     | Type guards and cache breakpoint helpers for VS Code LM parts                                                                            | **Yes**       |
| `src/positron/utils.ts`                          | `ensureUint8Array()` -- binary data normalization for cross-process data                                                                 | No            |
| `src/local-providers.ts`                         | `LocalProviderManager` class, `LOCAL_PROVIDER_IDS`, DI-based endpoint management (no vscode/node deps)                                   | No            |

## Provider Inventory

- `PROVIDER_IDS` (in `src/types.ts`) is the single source of truth for valid provider IDs; a `register*Provider()` function exists for every entry.
- `copilot` has a full SDK-based provider (`CopilotSdkClient`, `copilot-provider.ts`) in addition to the `vscode.lm` path in Positron

Positron's direct path uses two derived sets, so the counts stay correct as providers are added:

- `MAPPED_PROVIDER_IDS` -- every provider that has a `PROVIDER_MAP` auth mapping (computed from `PROVIDER_MAP`)
- `LOCAL_PROVIDER_IDS` -- the local, endpoint-based providers

Positron's direct providers are the union of those two sets. Currently:

- Mapped auth providers: `anthropic`, `positai`, `openai`, `gemini`, `google-vertex`, `openai-compatible`, `bedrock`, `ms-foundry`, `snowflake-cortex`, `copilot`, `deepseek`
- Local providers: `ollama`, `lmstudio`

## Base URLs

Model clients (`AnthropicClient`, `OpenAIClient`, `GeminiClient`) **trust the base URL they are given** — `params.baseUrl ?? this.baseURL`, used raw, with no chat-time correction. There used to be a `normalizeConfiguredBaseUrl` workaround inside the clients that patched a bare host (e.g. `https://api.anthropic.com`) to its versioned form at request time; that has been removed in favor of fixing the value once, upstream, at the config-read seam.

The correction policy itself lives in one public helper, `normalizeBaseUrlForProvider(providerId, url)` (`src/base-url.ts`, exported from the root entrypoint): it corrects a bare known host (anthropic/openai/gemini, tolerant of whitespace and trailing slashes) to `host/version`, and returns **any other input byte-for-byte unchanged** — so `result !== url` means precisely "bare-host fix applied." Consumers (Positron's `authentication-source.ts` and `fix-base-url-settings.ts`) use that identity check as their write-back/notification criterion. `normalizeProviderBaseUrl` (used by the model-discovery fetchers) is unrelated: it only fills in a host/version when the URL is unset and trims whitespace/trailing slashes for composition — it does not correct a configured bare host.

## Credentials

`ProviderCredentials` is a discriminated union (`apikey`, `oauth`, `local`, `aws-credentials`, `google-cloud`) produced by `CredentialProvider` implementations. Client factories receive the resolved credential object and use it to authenticate every model-discovery and chat request.

Credential resolution is split in two halves: session lookup (vscode-bound, `src/positron/auth.ts`) obtains the raw auth token, and shaping (pure, `src/credential-shaping.ts`) turns that token plus `authentication.*` settings (read through an injected `CredentialConfig`) into `ProviderCredentials`. Positron's headless language-model facade reuses the shaping half with its own config adapter.

**`ApiKeyCredentials.customHeaders`** -- Optional `Record<string, string>` of extra HTTP headers attached to every request for the provider. Intended for additive enterprise-gateway markers (e.g. Databricks `x-databricks-use-coding-agent-mode`, tenancy/routing headers). Precedence varies:

| Path                                                                                                          | Behavior                                                                                                         |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Model discovery (`cached-model-fetcher.ts`)                                                                   | Additive only. Provider-built headers win on collision.                                                          |
| OpenAI-compatible chat via `createOpenAICompatibleFetch`                                                      | Additive only. SDK-set headers win on collision.                                                                 |
| Direct-SDK chat (Anthropic, OpenAI, Gemini, DeepSeek, OpenRouter, Snowflake-Anthropic, OpenAI-compatible-SDK) | Passed to AI SDK's `headers` option; spread **after** SDK headers, so `customHeaders` **clobbers** on collision. |

Because the direct-SDK path clobbers, SDK-managed names (`Authorization`, `x-api-key`, `anthropic-version`, `Content-Type`) must NOT appear in `customHeaders` or auth/version negotiation breaks. The canonical contract lives at the `ApiKeyCredentials` JSDoc in `src/types.ts`.

## VS Code Language Model (vscode.lm) Integration

The `/positron` entrypoint exposes `VscodeLmClient` and `listVscodeLmModels()` -- shared `vscode.lm` client machinery. Any VS Code extension can send requests to `vscode.lm` models through the standard `ModelClient.chat()` interface, without needing `ProviderRegistry` or credentials (`vscode.lm` models are authenticated by the VS Code host).

### Components

| Component                     | What it does                                                              |
| ----------------------------- | ------------------------------------------------------------------------- |
| `VscodeLmClient`              | `ModelClient` implementation wrapping `vscode.LanguageModelChat`          |
| `listVscodeLmModels()`        | Discovers models via `vscode.lm` and enriches with capability metadata    |
| Vendor-to-ProviderId mapping  | Maps `vscode.lm` vendor strings to provider IDs                           |
| `fromAiMessages2()` + helpers | Converts AI SDK `ModelMessage[]` to VS Code `LanguageModelChatMessage2[]` |
| `lm-helpers.ts`               | Type guards and cache breakpoint helpers for VS Code LM parts             |

### Design decisions

- **No caching** -- `vscode.lm` path is uncached; `selectChatModels()` is called fresh each time.
- **No ProviderRegistry** -- `vscode.lm` models are host-authenticated; no `ProviderCredentials` needed. Consumers use `VscodeLmClient` + `listVscodeLmModels()` directly.
- **Positron compat shim** -- `fromAiMessages2()` accepts `{ supportsToolResultImages: boolean }` option. Host extensions inject platform version checks at the call site.

### Client-side token usage estimation

Neither the `vscode.lm` consumer API nor the provider-side `LanguageModelChatProvider` API has a
usage channel -- providers can only stream text, tool-call, data, and thinking parts. Positron
works around this for **its own** LM providers by emitting a side-channel
`LanguageModelDataPart` (`mimeType: "text/x-json"`, payload `{type: "usage", data: {...}}`) at
end of stream, which `VscodeLmClient.convertResponseStream()` parses into a `finish-step` with
real usage. The GitHub Copilot Chat extension's provider never emits that data part, so Copilot
requests (and any other third-party `vscode.lm` vendor) otherwise end with **no usage event at
all**.

**Trigger rule**: rather than keying on vendor, `VscodeLmClient` synthesizes estimated usage
whenever the stream ends without having seen a usage data part. This covers Copilot today,
automatically steps aside if a provider starts reporting real usage, and needs no vendor
allowlist. Positron's own providers are unaffected since they always emit the data part first.

**Mechanics** (`src/positron/token-estimation.ts`):

- **Input**: counted once, in `chat()`, over the _final post-transform_ `vscodeMessages` array
  (after system-prompt extraction, the Copilot system-as-user-message special case, and the
  tool-result-image transform) plus serialized tool definitions and the `system` parameter where
  it isn't already folded into messages -- counting "logical messages + system" separately would
  double-count Copilot's prepended system message. Because `convertResponseStream()` only sees
  the response stream (no messages/tools/system), `chat()` builds a lazy, **never-rejecting**
  thunk (`.catch()` attached at creation, resolving to `number | undefined`) and passes it plus
  the `LanguageModelChat` reference into the converter as a typed estimation context; the
  converter only awaits it at stream end, so providers that report real usage never pay the
  `countTokens()` cost.
- Per-message counts are memoized in a **module-level bounded LRU** (~500 entries) keyed by
  `model.id` + a hash of the serialized final message (role + all content parts), plus a small
  constant added per message for framing overhead. Module-level because `VscodeLmClient`
  instances are per-request -- a per-instance cache would never hit.
- **Output**: accumulated from streamed text deltas and tool-call inputs during
  `convertResponseStream()`; one `countTokens()` call on the accumulated text after the provider
  stream ends. Steady state is ~2 `countTokens()` calls per turn.
- **Emission**: the synthesized `finish-step` uses the same shape as the real usage-data-part
  path (`inputTokenDetails.noCacheTokens = inputTokens`, no cache fields) plus a marker,
  `providerMetadata.positai.usage.isEstimated = true` -- see `messageArchitecture.md` in the main
  monorepo for how core/UI consume that marker.
- **Failure policy**: estimation must never fail the request. Errors are caught and logged as a
  warning; the stream ends with no usage, matching pre-estimation behavior.

**Why `countTokens()` is cheap enough to call inline**: for Copilot models it's backed by a local
tiktoken BPE tokenizer (`cl100k_base`/`o200k_base` vocabularies bundled in the Copilot Chat
extension, tokenized in a worker thread) -- no network request, ~1-2ms of IPC per call (extension
host -> VS Code main -> Copilot Chat's provider -> its tokenizer worker). Counts are exact for
OpenAI-family models and an approximation for Anthropic/Gemini models served through Copilot
(same tokenizer, different real vocabulary). Message-framing and tool-schema overhead outside
`messages` is approximated with constants, and there is no cache-read/write breakdown to report
-- all input is counted as uncached. All of this is why results are estimates, not exact counts,
and why consumers must present them as such.

**Why VS Code's own cost/usage UI can't be reused**: it isn't built on `vscode.lm` at all. The
Copilot Chat extension is simultaneously the LM provider, the chat participant, and the HTTP
client, so it reads usage from first-party channels unavailable to LM consumers: the raw
OpenAI-style `usage` block in the `api.githubcopilot.com` response body, `x-quota-snapshot-*`
response headers for credit/quota state, and (once adopted) the proposed
`vscode.proposed.languageModelPricing` API for per-model credit rates
(`inputCost`/`outputCost`/`cacheCost` per `LanguageModelChatInformation`). Even VS Code's generic
context-window indicator hardcodes "0 tokens used" for third-party LM providers today
([microsoft/vscode#309207](https://github.com/microsoft/vscode/issues/309207)) -- there is no
provider-to-consumer usage channel for anyone, which is why estimation is the only option until
that gap closes. `languageModelPricing` is the future hook for a real Copilot cost figure once
Positron's VS Code base includes it.

## Provider Registration

`register-all-providers.ts` registers every provider into a caller-owned `ProviderRegistry`, honoring `config.allowedProviders`. It relies on `src/provider-registration.ts`, which holds the `ProviderRegistrationConfig` interface, the `RegisterAllProviders` signature type, and the `isProviderAllowed` predicate. Consumers that want to restrict the available provider set pass `allowedProviders`; there is no build-time provider filtering.

## Dependencies

The bridge owns its provider SDKs: all of them are regular `dependencies`, so a consumer installs them transitively and only needs to declare `ai-provider-bridge` in its own `package.json`. The `ai` types in the public API (e.g. `ModelMessage` on `ModelClient.chat`) are re-exported from the root entrypoint for the same reason, so consumers do not import `ai` directly either. The SDKs are marked `external` in `esbuild.config.ts` so they resolve from `node_modules` rather than being inlined -- several (`@aws-sdk/*`, `google-auth-library`) bundle poorly. `vscode` is the only optional peer dependency (host-provided; imported solely by `/positron`).

## Guidance for New Code

- **New provider modules, model clients, and capability helpers** go in `src/providers/`, `src/model-clients/`, and `src/model-capabilities/`
- **New provider IDs** are added to `PROVIDER_IDS` in `src/types.ts`
- **Positron auth mappings** are added to `PROVIDER_MAP` in `src/provider-map.ts`; the VS Code auth backend that consumes them is `createPositronBackend` in `ai-credentials/positron`
- **Avoid adding new `vscode` dependencies** to the root entrypoint -- the `/positron` entrypoint is the correct place for VS Code integration
