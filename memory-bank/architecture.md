---
title: Package Architecture
description: Architecture of ai-provider-bridge -- entrypoints, invariants, code layout, credential system, and VS Code LM integration.
---

# Package Architecture

## Overview

`ai-provider-bridge` is a platform-neutral package that owns the provider infrastructure: the plugin registry, model clients, provider registration modules, and credential access abstractions. It decouples LLM provider integration from both Node platform layers and the VS Code extension host.

Unless otherwise noted, provider counts below refer to the **internal build**. External builds alias provider metadata and provider registration down to `positai` only.

## Entrypoints

| Entrypoint                     | What it exports                                                                                                                                                        | vscode dependency? |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `ai-provider-bridge`           | `ProviderRegistry`, `ModelClient` interface, `StepLogger` interface, `CredentialProvider` interface, `createCachedModelFetcher`, `PROVIDER_MAP`, `MAPPED_PROVIDER_IDS` | No                 |
| `ai-provider-bridge/providers` | `register*Provider()` functions (14), all model client classes, AI SDK helpers, `openai-compat-fetch`, provider test utilities                                         | No                 |
| `ai-provider-bridge/positron`  | `PositronCredentialProvider`, `VscodeLmClient`, `listVscodeLmModels()`, `fromAiMessages2()`, LM helpers, `isProviderId()`, `toProviderId()`                            | **Yes**            |

## Invariants

- Root entrypoint **must not** import `vscode`
- Root entrypoint **must not** import any consumer package
- `/positron` entrypoint may import `vscode`
- Consumer packages (host applications) depend on `ai-provider-bridge`, **never** the reverse

## Code Layout

| Location                           | What it does                                                                                                        | VS Code deps? |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------- |
| `src/types.ts`                     | `PROVIDER_IDS` tuple (14 internal-build IDs) and `ProviderId` type -- single source of truth for valid provider IDs | No            |
| `src/providers/`                   | Provider registry, model fetchers, client factories (14 internal-build providers)                                   | No            |
| `src/model-clients/`               | Chat API clients (Anthropic, OpenAI, Gemini, Bedrock, Snowflake, Copilot SDK, DeepSeek, etc.) via AI SDK            | No            |
| `src/model-capabilities/`          | Per-provider capability inference helpers (model ID to capabilities mapping)                                        | No            |
| `src/provider-map.ts`              | `PROVIDER_MAP` and `MAPPED_PROVIDER_IDS` -- maps logical provider IDs to Positron auth provider config              | No            |
| `src/custom-headers.ts`            | Header merging/filtering utilities for custom HTTP headers                                                          | No            |
| `src/positron/auth.ts`             | `PositronCredentialProvider` -- VS Code auth adapter implementing `CredentialProvider`                              | **Yes**       |
| `src/positron/VscodeLmClient.ts`   | `VscodeLmClient` -- `ModelClient` implementation wrapping `vscode.LanguageModelChat`                                | **Yes**       |
| `src/positron/vscode-lm-models.ts` | `listVscodeLmModels()`, `toProviderId()`, `isProviderId()`, vendor-to-provider mapping                              | **Yes**       |
| `src/positron/message-formats.ts`  | `fromAiMessages2()` (AI SDK to VS Code direction), cache control helpers                                            | **Yes**       |
| `src/positron/lm-helpers.ts`       | Type guards and cache breakpoint helpers for VS Code LM parts                                                       | **Yes**       |
| `src/positron/utils.ts`            | `ensureUint8Array()` -- binary data normalization for cross-process data                                            | No            |
| `src/local-providers.ts`           | `LocalProviderManager` class, `LOCAL_PROVIDER_IDS`, DI-based endpoint management (no vscode/node deps)              | No            |

## Provider Inventory

In the internal build:

- `PROVIDER_IDS` (in `src/types.ts`) contains **14** IDs
- `register*Provider()` functions exist for all **14** providers
- `copilot` has a full SDK-based provider (`CopilotSdkClient`, `copilot-provider.ts`) in addition to the `vscode.lm` path in Positron

Positron's direct path uses:

- `MAPPED_PROVIDER_IDS` = **10** auth-bridge providers
- `LOCAL_PROVIDER_IDS` = **2** local providers

That gives Positron **12** direct providers:

- Mapped auth providers: `anthropic`, `positai`, `openai`, `gemini`, `google-vertex`, `openai-compatible`, `bedrock`, `ms-foundry`, `snowflake-cortex`, `copilot`, `deepseek`
- Local providers: `ollama`, `lmstudio`

## Credentials

`ProviderCredentials` is a discriminated union (`apikey`, `oauth`, `local`, `aws-credentials`, `google-cloud`) produced by `CredentialProvider` implementations. Client factories receive the resolved credential object and use it to authenticate every model-discovery and chat request.

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

## Internal / External Build Variants

External builds alias provider files to their `-external` variants via the consuming application's build configuration:

- `providers.ts` -> `providers-external.ts` -- only Posit AI provider
- `types.ts` -> `types-external.ts` -- only positai provider ID and notification actions
- `local-providers.ts` -> `local-providers-external.ts` -- empty `LOCAL_PROVIDER_IDS` and no-op `LocalProviderManager`

## Guidance for New Code

- **New provider modules, model clients, and capability helpers** go in `src/providers/`, `src/model-clients/`, and `src/model-capabilities/`
- **New provider IDs** are added to `PROVIDER_IDS` in `src/types.ts`
- **Positron auth mappings** are added to `PROVIDER_MAP` in `src/provider-map.ts` and `PositronCredentialProvider` in `src/positron/auth.ts`
- **Avoid adding new `vscode` dependencies** to the root entrypoint -- the `/positron` entrypoint is the correct place for VS Code integration
