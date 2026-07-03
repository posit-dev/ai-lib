---
title: Provider Implementation Guide
description: Step-by-step guide for adding new LLM providers to ai-provider-bridge.
package: ai-provider-bridge
---

# Provider Implementation Guide

Guide for adding new LLM providers to the ai-provider-bridge package.

## Overview

To add a provider, create:

1. **Client class** - Implements `ModelClient` interface
2. **Model fetcher** - Returns available models
3. **Provider module** - Registers client factory + model fetcher

**Reference implementations**: `src/providers/` and `src/model-clients/`

## Step 1: Add Provider ID

**File**: `src/types.ts`

Add the new ID to the `PROVIDER_IDS` array (single source of truth for valid IDs):

```typescript
export const PROVIDER_IDS = [..., "newprovider"] as const;
```

> **External build variants**: The external variant (`types-external.ts`) only includes positai. You don't need to modify it when adding a new non-positai provider -- the bundler aliasing in the consuming application handles exclusion automatically.

## Step 2: Choose Implementation Pattern

| Pattern               | When to Use                        | Example                                             |
| --------------------- | ---------------------------------- | --------------------------------------------------- |
| **AI SDK**            | Vercel AI SDK has provider package | `AnthropicClient`, `GeminiClient`, `DeepSeekClient` |
| **OpenAI-Compatible** | Provider implements OpenAI API     | `OpenAIClient`, `LMStudioClient`                    |
| **Custom**            | Unique API or auth requirements    | `PositAiClient`                                     |

## Step 3: Implement Client

**File**: `src/model-clients/NewProviderClient.ts`

Implement `ModelClient` interface with `chat()` method that returns `AsyncIterable<LMStreamPart>`.

**Key requirements**:

- Wire up `cancellationToken` to `AbortController`
- Convert provider stream format to `LMStreamPart`
- Handle errors gracefully

**Reference**: See `AnthropicClient.ts` (AI SDK pattern) or `OpenAIClient.ts` / `OllamaClient.ts` for wrapper-based implementations.

## Step 3b: Add Capability Helpers (Optional)

**File**: `src/model-capabilities/newprovider-helpers.ts`

If the provider has model-specific capabilities (vision, thinking, embeddings), add a helper that maps model IDs to `ModelCapabilities`. This is used by the model fetcher to annotate each model.

**Reference**: See `deepseek-helpers.ts`, `gemini-helpers.ts`, or `anthropic-helpers.ts`.

## Step 4: Implement Model Fetcher

Create a function returning `ModelInfo[]`. Two approaches:

| Approach                 | When to Use                   |
| ------------------------ | ----------------------------- |
| **Static list**          | Few models, rarely changes    |
| **Dynamic with caching** | Many models, has API endpoint |

**Reference**: See `anthropic-provider.ts` for dynamic fetching with TTL cache and fallback.

## Step 5: Create Provider Module

**File**: `src/providers/newprovider-provider.ts`

```typescript
export function registerNewProviderProvider(registry: ProviderRegistry, logger: Logger): void {
  registry.registerModelFetcher("newprovider", createModelFetcher(logger));
  registry.registerClientFactory("newprovider", (creds) => new NewProviderClient(creds.apiKey));
}
```

## Step 6: Export from Package

**File**: `src/providers.ts`

Add an export for the new `register*Provider()` function. Also export the client class if it has public API.

## Step 7: Positron Auth Mapping (Optional)

If the provider should be accessible through Positron's auth extension:

1. Add a mapping in `src/provider-map.ts` (`PROVIDER_MAP` and `MAPPED_PROVIDER_IDS`)
2. Add credential handling in the Positron auth backend `ai-credentials/src/positron/PositronBackend.ts` (`createPositronBackend`) — credential resolution moved out of the bridge into `ai-credentials` in Phase 7

Do **not** add a Positron auth mapping unless the underlying auth provider actually exists in Positron.

If it is a local endpoint provider, add it to `LOCAL_PROVIDER_IDS` in `src/local-providers.ts` and wire through `LocalProviderManager`.

## Files Summary

| File                                    | Change                                    |
| --------------------------------------- | ----------------------------------------- |
| `src/types.ts`                          | Add to `PROVIDER_IDS`                     |
| `src/model-clients/XyzClient.ts`        | New client class                          |
| `src/model-capabilities/xyz-helpers.ts` | Optional: capability inference helpers    |
| `src/providers/xyz-provider.ts`         | New provider module                       |
| `src/providers.ts`                      | Export new registration function + client |
| `src/provider-map.ts`                   | Optional: add Positron auth mapping       |
| `src/positron/auth.ts`                  | Optional: add credential handling         |

## Thinking/Reasoning Support

If the provider's models support thinking/reasoning:

1. **Declare capability** in model capabilities: Add `thinkingEffortLevels: ["off", "low", "medium", "high"]` (or a subset) to `ModelCapabilities`. This is typically done in the capability inference function.

2. **Map effort in client**: In the client's `chat()` method, check `isThinkingEnabled(params.thinkingEffort)` from `src/utils.ts`. If enabled, map the effort string to the provider's API parameter format.

3. **Stream handling**: The AI SDK provider should emit `reasoning-start/delta/end` events -- consumers handle these generically.

**Reference**: See `GeminiClient.ts` for a provider with model-specific thinking budgets, or `AnthropicClient.ts` for a simpler mapping.

## Custom Headers Support

New providers should support the `customHeaders` field from `ApiKeyCredentials`. The pattern:

- **Model discovery** (via `createCachedModelFetcher`): Pass `credentials.customHeaders` -- the fetcher handles merging (additive only, provider headers win on collision).
- **Direct-SDK chat**: Pass `customHeaders` to the AI SDK's `headers` option. See `AnthropicClient.ts` or `OpenAIClient.ts` for the pattern.
- **OpenAI-compatible chat** (via `createOpenAICompatibleFetch`): Pass `customHeaders` -- the wrapper handles merging.

See `src/custom-headers.ts` for the shared filtering/merging utilities.

## Common Pitfalls

- **Don't modify the registry class** -- Use the plugin pattern (`registerModelFetcher` / `registerClientFactory`)
- **Always handle missing credentials** -- Return fallback models, don't throw
- **Wire up cancellation** -- Pass `AbortController` signal to fetch/SDK
- **Test offline** -- Graceful degradation with fallback models
