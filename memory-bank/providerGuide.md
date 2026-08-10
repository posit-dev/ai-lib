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
- Act only on the capability params the host hands you (`supportsImages`,
  `usesExplicitPromptCaching`, …) — never infer capabilities from model IDs. A client that
  never reads `usesExplicitPromptCaching` is correct by default: absent means "emit no explicit
  cache fields", which is every provider's default behavior.

**Reference**: See `AnthropicClient.ts` (AI SDK pattern) or `OpenAIClient.ts` / `OllamaClient.ts` for wrapper-based implementations.

## Step 3b: Add Capability Helpers (Optional)

**File**: `packages/ai-config/src/model-capabilities/newprovider-helpers.ts`

If the provider has model-specific capabilities (vision, thinking, embeddings), add a helper that maps model IDs to `ModelCapabilities`. This is used by the model fetcher to annotate each model. The capability tables live in `ai-config` (moved there in ai-lib#9 so any `ai-config` consumer can call `inferModelCapabilities` without the bridge's dependency tree); the bridge imports the helper from `ai-config` at its call sites.

**Reference**: See `deepseek-helpers.ts`, `gemini-helpers.ts`, or `anthropic-helpers.ts` in `packages/ai-config/src/model-capabilities/`.

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

### Providers with per-model endpoints

Discovery may set `ModelInfo.baseUrl` when one provider serves model families
from different endpoints. Treat it as a discovered default, not a user
override. `resolveModels()` applies this precedence:

1. model override/custom-model `baseUrl`
2. provider `endpoints[resolvedProtocol]`
3. discovered model `baseUrl`
4. provider-wide `baseUrl`
5. client default

Bedrock is the reference: Mantle discovery lists all models at `/v1/models`,
while gpt-oss inference uses `/v1` and GPT-5.x Responses inference uses
`/openai/v1`. The provider assigns the inference endpoint from its family
capability rule rather than assuming the listing path is callable.

### Custom-provider registrars (kind-keyed factory)

When a provider kind can also back `providers.custom` entries (LiteLLM and
Portkey expose `registerCustomLitellmProvider` and
`registerCustomPortkeyProvider`), the module exports a second registrar that
consumers call once per custom entry:

- The **model fetcher** is registered under the custom provider id, with its
  own `createCachedModelFetcher` instance (independent per-gateway cache) and
  the custom id stamped into each discovered `ModelInfo`.
- The **client factory** is registered under the kind key only (e.g.
  `"litellm"`), never under the custom id. Chat resolution reaches it through
  `getClientForProviderOrKind`'s `clientKind` fallback, which reads the
  _current_ catalog kind. `ProviderRegistry` has no unregister, and consumers
  re-run registration against the same registry on live providers.json
  reloads — an id-keyed factory would keep serving the old client after an
  entry's `type` changes. Per-id fetchers are safe because every pass
  re-registers something for each current custom id (`Map.set` overwrites).

All wire knowledge (URL normalization, discovery parsing, header schemes)
stays inside the provider module; callers supply only an id.

A kind-keyed factory does **not** mean every custom kind discovers models.
LiteLLM's registrar fetches `/v1/model/info`. Ordinary self-hosted custom
Portkey resolves its shared connection policy and deliberately returns no
fetched models; the consuming catalog merges bare-ID `models.custom`
declarations later. Portkey's canonical hosted fetcher remains shared for a
securely stored key, but is not the keyless custom v1 contract.

### Protocol-dispatching clients (gateway providers)

When one provider fronts upstreams that speak different wire protocols
(LiteLLM is the reference), the client factory returns a small dispatching
client that owns one delegate per protocol family and routes each `chat()`
call on `normalizeProtocol(params.protocol)`:

- LiteLLM owns exactly two delegates: an `AnthropicClient` (`/v1/messages`)
  and one `OpenAIClient` — the OpenAI client already selects
  `/chat/completions` vs `/responses` per request from `params.protocol`, so
  it is not split in two.
- `undefined` protocol takes the provider's default route (for LiteLLM:
  Anthropic-shaped — declared `models.custom` entries may omit `protocol`).
  Protocols with no route are rejected with an error naming the model.
- The **fetcher stamps the per-alias default protocol** on each `ModelInfo`;
  family detection is single-sourced in ai-config (`classifyLitellmModel`)
  and shared with capability inference so routing and capabilities agree.
  The catalog resolver applies the standard precedence on top (user override
  > connection `protocol` > fetcher stamp).
- Both delegates get the same normalized base URL and credentials
  (`customHeaders` must flow to every delegate — gateway tenancy headers are
  route-independent; auth headers stay delegate-owned).

**Portkey is the second dispatcher, deliberately mirrored — not extracted**
(2026-08-08; decision comment in `portkey-provider.ts`). Its wrinkle is
per-mode credential wiring: LiteLLM sends the same key in each delegate's
native scheme, while hosted Portkey sends `x-portkey-api-key` on both
delegates with dummy native credentials, and OSS Portkey sends the upstream's
key. The standing judgment: extract a shared
`createProtocolDispatchingClient` only when a **third** gateway provider
arrives and the credential parameterization proves clean across all three;
until then, mirror with the convention documented here rather than forcing a
shallow abstraction.

**Template for future gateway providers** (from the Portkey plan,
`plans/2026-08-08-1001-portkey-multiprotocol-provider.md` in the consuming
monorepo): gate implementation on **empirical probes** of the real gateway
(auth matrix per endpoint, tools + streaming per upstream family, Responses
stateless reasoning continuity, discovery/pagination shape, error/edge
shapes), define an **outcome matrix** up front so each probe failure maps to
a defined narrower ship (e.g. exclude that family from discovery) instead of
blocking, and pin fixes with **repro-first tests** (the repro must fail on
the unfixed code before the fix lands). Families whose probes never ran ship
excluded-with-reason, and widening later is additive.

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

| File                                                 | Change                                                        |
| ---------------------------------------------------- | ------------------------------------------------------------- |
| `src/types.ts`                                       | Add to `PROVIDER_IDS`                                         |
| `src/model-clients/XyzClient.ts`                     | New client class                                              |
| `../ai-config/src/model-capabilities/xyz-helpers.ts` | Optional: capability inference helpers (lives in `ai-config`) |
| `src/providers/xyz-provider.ts`                      | New provider module                                           |
| `src/providers.ts`                                   | Export new registration function + client                     |
| `src/provider-map.ts`                                | Optional: add Positron auth mapping                           |
| `src/positron/auth.ts`                               | Optional: add credential handling                             |

## Thinking/Reasoning Support

If the provider's models support thinking/reasoning:

1. **Declare capability** in model capabilities: Add the levels the endpoint
   actually accepts. Only expose `"off"` when the client maps it to a verified
   wire-level disable; omitting a reasoning field usually means provider
   default, not disabled.

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
