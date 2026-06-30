---
title: Gemini Interactions API
description: Stateful chaining design, unsigned-reasoning filtering, and known API gotchas for the Gemini Interactions path.
package: ai-provider-bridge
---

# Gemini Interactions API

How `GeminiClient` uses the Gemini Interactions API (`provider.interactions(modelId)`)
for stateful conversation chaining.

## Stateful Chaining

All Gemini requests use the Interactions API with `store: true`. The server stores
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
- `thinkingLevel` — validated against per-model `INTERACTIONS_PROFILES`

## `thinkingSummaries` — Intentionally Disabled

`thinkingSummaries: "auto"` is **not** set. Two confirmed failure paths:

1. **Chained continuation**: summaries poison the server-stored interaction state.
   The subsequent `function_result` continuation is rejected with HTTP 400
   ("Request contains an invalid argument."). Client-side code cannot fix this.
2. **Full-history retry path**: the summarized `thought` comes back with
   `signature: ""`, which (before hardening) bypassed `filterUnsignedReasoning`.

Since this product almost always sends tools, summaries would rarely work correctly.
They are disabled entirely pending a Google API-side fix.

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
