---
title: OpenCode Protocol Routing
description: OpenCode Go/Zen model → wire-protocol routing — mapping ownership in ai-config, product-aware inference, bridge dispatch, per-route auth, Gemini profile gating, and the maintenance procedure for future OpenCode models.
---

# OpenCode Protocol Routing

The built-in `opencode` provider (one provider ID, `openai` client kind) covers both hosted
OpenCode products — Go (`https://opencode.ai/zen/go/v1`) and Zen (`https://opencode.ai/zen/v1`) —
whose catalogs mix many upstream vendors behind OpenCode's own model ids. Each model must be
reached over its **documented** wire protocol; this document owns the routing description and the
maintenance procedure.

Canonical documentation sources (endpoint tables reviewed 2026-09-11 UTC):

- https://opencode.ai/docs/go.md
- https://opencode.ai/docs/zen.md

Keep these Markdown links even if a particular fetch fails; the corresponding HTML pages are a
fallback, not a replacement. `/models` on both products is publicly readable and carries only
id/object/created/owner — no protocol or endpoint metadata — so the docs tables are the routing
authority.

## Mapping ownership and precedence

`ai-config/src/model-capabilities/opencode-routing.ts` is the single owner of the
model-id → protocol mapping: `inferOpencodeProtocol(modelId, baseUrl)` and
`opencodeProductForBaseUrl(baseUrl)`. Three consumers share it, so the mapping can never drift:

1. The bridge's OpenCode discovery `enrichModels` pass stamps each parsed model with the
   provider-default inferred protocol (the parse itself stays payload-only).
2. `resolveModels` recomputes the low-priority inferred stamp under the full routing context when
   called with `ModelResolutionContext { providerId: "opencode" }` — both hosts (Node
   `NodeModelService`, Positron `catalog-adapter`) pass it. Only this seam sees a model-level URL
   override, which can canonically point at the other product and change the documented route
   (MiniMax is the case: Messages on Go, Chat Completions on Zen).
3. The bridge's client factory infers a protocol for direct chat calls that arrive without one
   (the registry permits chat without prior discovery).

Precedence, unchanged from the shared ladder:

- Protocol: explicit model override or declared-model `protocol` → provider `protocol` → inferred
  OpenCode routing → discovered stamp. A discovered stamp is not user intent and is always
  recomputed at final resolution.
- Endpoint: explicit model `baseUrl` → provider `endpoints[resolvedProtocol]` → discovered model
  URL → provider `baseUrl` → client default. Protocol-keyed endpoints are destinations for an
  already-selected protocol, never inputs that select one (no feedback loop).

Within inference: exact product/model exception (empty today), then family rule, then Chat
Completions fallback. Matching is anchored, lowercase, against the catalog id; the id sent to
OpenCode is never rewritten. An absent URL means the built-in default product
(`OPENCODE_DEFAULT_PRODUCT`); an unrecognized explicit URL (proxy/gateway alias) classifies as no
product and falls back to Chat Completions — it must not be silently classified as either product.

The family rules (generalizing the documented tables; OpenCode does not promise prefixes hold for
future ids):

| Model id prefix | Go                 | Zen                 |
| --------------- | ------------------ | ------------------- |
| `gpt-`          | `openai-responses` | `openai-responses`  |
| `grok-`         | `openai-responses` | `openai-responses`  |
| `muse-spark-`   | `openai-responses` | `openai-responses`  |
| `claude-`       | (not listed)       | `anthropic-messages`|
| `qwen`          | `anthropic-messages`| `anthropic-messages`|
| `minimax-`      | `anthropic-messages`| `openai-chat`       |
| `gemini-`       | (not listed)       | `google-generative` |
| otherwise       | `openai-chat`      | `openai-chat`       |

"Not listed" falls through to Chat Completions; inference must never add Claude or Gemini to Go's
catalog.

## Capabilities stay separate

Routing is a documented service contract, independent of capability probes.
`opencode-helpers.ts` (`getOpencodeModelCapabilities`) holds only probe-verified capability
overrides (context limits, vision, tools) and stamps **no protocol** — it has no product context,
so an id-only protocol answer (MiniMax!) would be invented, not derived. Selecting Responses does
not grant direct-OpenAI capabilities; Messages does not grant Claude capabilities to Qwen/MiniMax.
Earlier free-tier probes (`/responses` 500s on the probeable free models, 2026-09-09) were
incorrectly generalized into routing defaults; protocol selection now follows the docs tables.

## Bridge dispatch and per-route auth

`opencode-provider.ts`'s client factory returns a dispatcher (the Databricks composition
precedent) over three delegates sharing the resolved API root — the SDKs append only their
operation paths (`/responses`, `/chat/completions`, `/messages`,
`/models/{model}:generateContent`):

- `openai-chat` / `openai-responses` → one `OpenAIClient` (constructor `apiMode: "completions"`;
  a stamped/params protocol picks the mode per request).
- `anthropic-messages` → `AnthropicClient`.
- `google-generative` → `GeminiGenerateContentClient`.
- Anything else → a clear local error, never silent coercion into Chat Completions.

Authentication is **per route**, probe-verified on both products 2026-09-11 with dummy-key header
probes ("Invalid API key." vs "Missing API key." distinguishes a read header from an ignored one):

- OpenAI routes (`/responses`, `/chat/completions`, `/models`): `Authorization: Bearer <key>`.
- Messages route: the Anthropic-native `x-api-key` header — **not** Bearer.
- generateContent route: the Google-native `x-goog-api-key` header — **not** Bearer.

So each delegate runs in its SDK's native auth mode (`{ apiKey }` for Anthropic/Gemini). This
matches the docs' per-model "AI SDK Package" column: the vendor SDK, native auth, OpenCode base
URL.

The destination-based header policy (`mergeOpencodeHeaders`: generated `x-opencode-session` from
`metadata.rootConversationId` wins over static workarounds; host User-Agent beneath an explicit
custom one; no headers on non-OpenCode destinations) applies on all three delegates —
`GeminiGenerateContentClient` gained the same `userAgent` constructor parameter and request-time
merge the OpenAI/Anthropic clients already had. Discovery carries the host User-Agent but never a
session header, and the discovery cache stays partitioned by the resolved credential base URL so a
product switch refetches.

## Gemini profile gating

`GeminiGenerateContentClient` requires `getGeminiGenerateContentProfile(modelId)` to build wire
`thinkingConfig`; the 3.x rules are exact per documented variant (level sets differ per variant —
3.7/3.8 Flash accept `low`/`medium`/`high`, no `minimal`; verified against
https://ai.google.dev/gemini-api/docs/thinking, page updated 2026-09-09 UTC, reviewed 2026-09-11).
OpenCode discovery **excludes** a Gemini-stamped model with no verified profile (actionable
`logger.warn` diagnostic) rather than advertising an unusable model; an explicit configured model
with such an id surfaces the client's unsupported-variant error. No silent Chat Completions
fallback — its compatibility is unproven.

## Updating future models

The procedure when OpenCode's catalogs change:

1. **Check availability and the service contract separately.** Compare Go and Zen `/models` with
   their endpoint tables. `/models` contains no protocol metadata. Consult both products; do not
   assume shared ids use the same protocol.
2. **Existing family, same route:** no mapping change is necessary. The prefix rule handles new
   versions and suffixes. Check that native client prerequisites, especially Gemini profiles,
   support the new id. Add capability facts only with separate evidence.
3. **One model breaks a family rule:** add an exact product/model exception before family rules,
   with a source link, verification date, and short reason. Avoid weakening the entire family.
4. **New family:** use a family rule only when the documented entries support a consistent route.
   Otherwise use exact rules until the pattern is established. Keep the unknown-model Chat
   Completions fallback documented as a compatibility assumption, not verified support.
5. **A product changes a family's route:** update the product-aware rule, verify both products,
   and remove exceptions that are now redundant. Review product-switch and override behavior.
6. **A new wire protocol appears:** add an explicit delegate and vocabulary/schema support only
   when the client can actually speak it; update both vocabulary mirrors and shape guards. Do not
   map an unknown API to the nearest familiar protocol. Explain unsupported models clearly.
7. **Gemini variant:** verify/add its generateContent profile, update supported discovery, and
   test any changed request-shaping logic. Do not guess thinking parameters or use Interactions.
8. **Validate proportionately:** existing table-mechanism tests cover simple new rows. Add a test
   only for a new behavior, regression, or protocol shape; do not copy static rows into
   assertions. Run a targeted live probe when accessible and record its limits.
9. **Refresh documentation and deliver both repositories:** update the source/date notes and
   relevant capability evidence, land ai-lib, then update Assistant's gitlink and rebuild. Do not
   edit generated website reference files manually.

If OpenCode later adds authoritative routing metadata to `/models`, consume validated metadata as
an inferred default below user configuration and retain the family mapping for older responses.
