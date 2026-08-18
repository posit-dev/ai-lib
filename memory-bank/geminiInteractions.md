---
title: Gemini Interactions API
description: Stateful chaining design, unsigned-reasoning filtering, the raw-usage metadata hoist, and known API gotchas for the Gemini Interactions path, contrasted with the stateless generateContent client used by gateways like Databricks.
package: ai-provider-bridge
---

# Gemini Interactions API

How `GeminiClient` uses the Gemini Interactions API (`provider.interactions(modelId)`)
for stateful conversation chaining.

## Two Gemini Clients

Not all Gemini requests use the Interactions API. `GeminiClient` (this
document) is the direct-API path and always speaks Interactions. A second,
separate class, `GeminiGenerateContentClient`
(`src/model-clients/GeminiGenerateContentClient.ts`), speaks the plain
`generateContent` surface (`POST {baseURL}/models/{model}:generateContent`)
for gateways that expose Gemini-compatible passthrough but not the
Interactions API — currently Databricks' native routing (see
`memory-bank/architecture.md`'s Databricks section and
`memory-bank/aiConfig.md`'s `inferDatabricksModelProfile`). It is a separate
class rather than a mode flag: `GeminiClient` is deeply Interactions-specific
(interaction-ID extraction, delta history, expired-ID retry), and forcing both
surfaces through one bimodal class would blur that.

The two clients differ at every point their host surface differs:

| Aspect              | `GeminiClient` (Interactions)                                                                                                      | `GeminiGenerateContentClient` (generateContent)                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| State               | Stateful — chains via `previousInteractionId`, sends only delta messages when chaining                                             | Stateless — always sends full local history; nothing to chain, nothing can expire                                                                                                          |
| Reasoning signature | `providerOptions.google.signature`, filtered by `filterUnsignedReasoning()`                                                        | `providerOptions.google.thoughtSignature`, filtered by `sanitizeGenerateContentHistory()`; also preserves tool-call signatures, which Gemini 3 validates on replay                         |
| Retry               | `withExpiredIdRetry()` retries once on expired-interaction errors                                                                  | No retry path — there is no interaction ID to expire                                                                                                                                       |
| Thinking control    | `thinkingLevel` mapped from the product-level effort via per-model `INTERACTIONS_PROFILES` (`effortToWireLevel`), top-level option | `thinkingConfig`: numeric `thinkingBudget` for Gemini 2.5 variants, categorical `thinkingLevel` for 3.x, derived from ai-config's `getGeminiGenerateContentProfile` at variant granularity |
| Auth                | SDK-native                                                                                                                         | `apiKey` mode uses the SDK's native `x-goog-api-key`; `authToken` (bearer gateways) uses a fetch middleware that sets `Authorization: Bearer` and strips `x-goog-api-key`                  |

`sanitizeGenerateContentHistory()` is deliberately **not** a reuse of
`filterUnsignedReasoning()`: the two APIs key signed reasoning on different
`providerOptions.google` fields, so applying the Interactions filter to
generateContent history would discard every valid thought, and vice versa.

## Stateful Chaining (Interactions API)

All requests through `GeminiClient` use the Interactions API with `store: true`. The server stores
interaction state, enabling efficient continuations.

- **`extractPreviousInteractionId()`** scans message history backwards to find the
  most recent assistant response with an `interactionId` (from `providerMetadata.google`).
- When chaining (`previousInteractionId` is set), only the delta messages after the
  linked assistant response are sent — the server reconstructs context from stored state.
- When starting fresh (no ID, or after compaction boundary), the full history is sent
  with unsigned reasoning filtered out.
- Compaction boundaries (system messages that act as summary markers) are treated as
  hard stops — the client never chains across them.

## `filterUnsignedReasoning()`

Before sending full history on a fresh interaction, reasoning parts without valid Google
signatures are removed. Google rejects unsigned thought steps in the Interactions API.

**Guard logic**: `typeof google?.signature === "string" && google.signature !== ""`.
This is a **non-empty-string guard** (not just `!== undefined`) because Google returns
`signature: ""` for summarized thoughts, and the SDK's input converter only guards
`signature != null`. Empty, null, undefined, and non-string signatures are all rejected.

## `buildInteractionsOptions()`

Builds `providerOptions.google` for each request:

- `store: true` — always (stateful mode)
- `previousInteractionId` — when chaining
- `thinkingLevel` — mapped from the product-level thinking effort through the
  per-model profile's `effortToWireLevel` (see below)
- `thinkingSummaries: "auto"` — when the model has an Interactions profile

**Product efforts and wire values are separate vocabularies.** Core/UI own the
product levels; each `INTERACTIONS_PROFILES` entry owns the translation to the
wire `thinkingLevel`. For most Gemini models the mapping is identity
(`low→low`, …). An effort with no mapping (including `off` for models that
cannot disable thinking) omits `thinkingLevel` entirely, leaving the model at
its default — unrecognized efforts are deliberately **not** clamped.

## Hosted Gemma

The Gemini API endpoint also serves Gemma 4 (`gemma-4-31b-it`,
`gemma-4-26b-a4b-it`), verified against the live API (2026-08-17):

- **Binary thinking**: wire `thinkingLevel` accepts only `minimal` (off) and
  `high` (on) — other values are rejected with HTTP 400. The default when
  omitted is **ON**, so the product `off` effort maps to an explicit wire
  `minimal`. Product levels are `["off", "high"]` (ai-config's Gemini-API
  endpoint composition); the profile maps `off→minimal`, `high→high`.
- **Token limits**: 262,144 input / 32,768 output (from `GET /v1beta/models`).
- **Capabilities**: function calling, image input (png/jpeg/gif/webp),
  `application/pdf` input (SDK file parts → `document` type), and images in
  tool results all work; thought summaries and signatures are emitted.
- Eligibility: both IDs carry `INTERACTIONS_PROFILES` entries (the thinking
  gate). Capabilities come from ai-config's `getGeminiApiModelCapabilities`
  (NOT `gemma-helpers.ts`, which is the Posit AI/vLLM `off`/`on` +
  `chat_template_kwargs` contract).

## Discovery: fail-open, thinking: fail-closed

Two gates with different postures (added 2026-08-17, after Gemma and then
Gemini 3.6/3.7 Flash were invisible until manually allowlisted):

- **Discovery** (`isGeminiApiChatModel`) is **fail-open**: any chat-shaped
  model the `/models` endpoint lists may appear in the picker — versioned
  `gemini-\d`/`gemma-\d` IDs, excluding known non-chat suffixes
  (`-image`, `-tts`, `-computer-use`), and requiring `generateContent` in
  `supportedGenerationMethods` when reported (excludes `bidiGenerateContent`
  audio/live models and `embedContent` embedding models). `-latest` aliases
  fail the versioned-ID check, avoiding duplicate picker entries. An
  unprofiled model chats at its default thinking state; the worst case for a
  bad inclusion is a visible, retryable error on the first turn.
- **Thinking** (`INTERACTIONS_PROFILES`) stays **fail-closed**: valid
  `thinkingLevel` values cannot be inferred — gemini-3.7-flash rejects
  `minimal` while 3.6-flash accepts it (verified 2026-08-17); hosted Gemma
  takes only `minimal`/`high`. Unprofiled models advertise no
  `thinkingEffortLevels` (`buildGeminiModel` strips them) and the client
  sends no `thinkingLevel`/`thinkingSummaries`.

## Raw Usage Metadata Hoist

The SDK's interactions provider reports token usage only as `usage.raw` on
finish parts; its finish `providerMetadata.google` carries just
`interactionId` and `serviceTier` (unlike the generateContent surface, which
publishes `google.usageMetadata`). Hosts persist finish-step
`providerMetadata` on the assistant message — that is how Anthropic's raw
usage reaches disk — so without intervention the raw Gemini usage would be
dropped.

`hoistRawUsageMetadata()` copies `usage.raw` into
`providerMetadata.google.usageMetadata` on every finish-step part. The
private `withRawUsageMetadata()` generator applies it to the whole stream,
wrapping _outside_ `withExpiredIdRetry()` so the retry attempt's parts are
covered too. An already-present `usageMetadata` is never overwritten.

Consumers therefore find Gemini token counts under one key in either API
shape: camelCase (`promptTokenCount`, `cachedContentTokenCount`, …) from
generateContent, snake_case (`total_input_tokens`, `total_cached_tokens`, …)
from Interactions. The assistant monorepo's `extractDetailedUsage` reads
both shapes (and falls back to `usage.raw` directly if the hoist did not
run).

## Expired-Interaction Retry

`withExpiredIdRetry()` wraps the stream to retry exactly once on expired-interaction
errors. On retry, it resends the full signature-filtered history with no
`previousInteractionId` (fresh interaction). The replacement `interactionId` persists
via the normal finish-metadata path.

## Error Diagnostics

- `serializeGeminiError()` handles two error shapes: `APICallError` (thrown/pre-stream)
  and streamed SSE error parts (`{code, message}`).
- Per-request chaining decisions are logged at `debug` level.
- Error events (stream error parts and thrown errors) are logged at `info` level.
