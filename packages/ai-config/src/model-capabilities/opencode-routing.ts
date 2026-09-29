/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenCode Go/Zen wire-protocol routing.
 *
 * This module is the SINGLE owner of the model-id → wire-protocol mapping for
 * the built-in `opencode` provider. It answers one question: given a model id
 * and the resolved connection URL (which selects the product), which protocol
 * should a request speak? It is consumed by:
 *
 * - the bridge's OpenCode discovery enrichment (stamps the provider-default
 *   protocol on each discovered model),
 * - `resolveModels` (recomputes the low-priority inferred stamp under the
 *   full routing context, including cross-product model URL overrides), and
 * - the bridge's OpenCode client dispatch (direct chat calls that arrived
 *   with no protocol at all).
 *
 * Routing follows OpenCode's documented per-model endpoint tables — NOT
 * capability probes: protocol selection is a documented service contract,
 * independent of what a free-tier probe could reach. Capabilities (context
 * limits, vision, tools) live separately in `opencode-helpers.ts`.
 *
 * Sources (endpoint tables reviewed 2026-09-11 UTC):
 *
 * - https://opencode.ai/docs/go.md
 * - https://opencode.ai/docs/zen.md
 *
 * Keep these links even if a particular fetch fails; the corresponding HTML
 * pages are a fallback, not a replacement for the Markdown references. The
 * maintenance procedure for future models lives in ai-lib's memory bank
 * (`memory-bank/opencodeRouting.md`).
 */

import type { OpencodeProduct } from "../base-url.js";
import {
	OPENCODE_DEFAULT_PRODUCT,
	OPENCODE_GO_BASE_URL,
	OPENCODE_ZEN_BASE_URL,
} from "../base-url.js";
import type { Protocol } from "../vocabulary.js";

/** Chat Completions: the fallback route on both products. */
const FALLBACK_PROTOCOL: Protocol = "openai-chat";

/**
 * Classify a resolved connection/model URL into an OpenCode product.
 *
 * Only the two canonical API roots classify: an absent URL means the built-in
 * default product (discovery/chat fall back to it when credentials carry none);
 * an unrecognized explicit URL (a proxy/gateway alias) returns `undefined` —
 * it must NOT be silently classified as either product, so the caller applies
 * the documented conservative fallback instead of a product-dependent rule.
 */
export function opencodeProductForBaseUrl(
	baseUrl: string | undefined,
): OpencodeProduct | undefined {
	const normalized = baseUrl?.trim().replace(/\/+$/, "");
	if (!normalized) {
		return OPENCODE_DEFAULT_PRODUCT;
	}
	if (normalized === OPENCODE_GO_BASE_URL) {
		return "go";
	}
	if (normalized === OPENCODE_ZEN_BASE_URL) {
		return "zen";
	}
	return undefined;
}

/**
 * An exact product/model exception, checked BEFORE the family rules. Add one
 * only when a single documented model breaks its family's route — with a
 * source link, verification date, and short reason — rather than weakening
 * the whole family (see the maintenance procedure). Empty today.
 */
interface OpencodeExactRule {
	readonly product: OpencodeProduct;
	readonly modelId: string;
	readonly protocol: Protocol;
}

// prettier-ignore
const EXACT_RULES: readonly OpencodeExactRule[] = [
	// No exceptions today. Example shape:
	// { product: "zen", modelId: "gpt-5.6-luna", protocol: "openai-chat" }, // reason, source, date
];

/**
 * A model-id family rule. Matching is anchored and lowercase against the
 * catalog id (which is never rewritten). A product left absent means the
 * family is not listed on that product today (e.g. Claude and Gemini are
 * Zen-only), so the product's fallback applies there.
 */
interface OpencodeFamilyRule {
	readonly match: RegExp;
	readonly protocols: { readonly [P in OpencodeProduct]?: Protocol };
}

/**
 * Family rules generalizing the documented endpoint tables (2026-09-11 UTC).
 * OpenCode does not promise these prefixes hold for all future ids — they
 * apply only within built-in OpenCode routing, never globally. `qwen` has no
 * required hyphen because current ids begin `qwen3.`; `gpt`/`grok`/`claude`/
 * `minimax`/`gemini`/`muse-spark` all carry hyphen boundaries in today's ids.
 */
const FAMILY_RULES: readonly OpencodeFamilyRule[] = [
	// GPT: `/responses` on both products (Go lists gpt-5.6-luna; Zen lists the
	// full gpt-* range).
	{ match: /^gpt-/, protocols: { go: "openai-responses", zen: "openai-responses" } },
	// Grok: `/responses` on both products.
	{ match: /^grok-/, protocols: { go: "openai-responses", zen: "openai-responses" } },
	// Muse Spark: `/responses` on both products (Zen's `-contributor-free` and
	// Go's `-contributor` suffixes both fall under the prefix).
	{ match: /^muse-spark-/, protocols: { go: "openai-responses", zen: "openai-responses" } },
	// Claude: `/messages` — Zen only.
	{ match: /^claude-/, protocols: { zen: "anthropic-messages" } },
	// Qwen: `/messages` on both products.
	{ match: /^qwen/, protocols: { go: "anthropic-messages", zen: "anthropic-messages" } },
	// MiniMax is the product-dependent family: `/messages` on Go but
	// `/chat/completions` on Zen.
	{ match: /^minimax-/, protocols: { go: "anthropic-messages", zen: "openai-chat" } },
	// Gemini: generateContent (`{root}/models/{id}:generateContent`) — Zen only.
	{ match: /^gemini-/, protocols: { zen: "google-generative" } },
];

/**
 * Infer the wire protocol for an OpenCode-hosted model id under the product
 * the URL resolves to.
 *
 * Precedence within the inferred default: exact product/model exception, then
 * family rule, then the Chat Completions fallback. The fallback also applies
 * when the URL is an unrecognized proxy (no product context) — Chat
 * Completions is the conservative route both products are known to serve.
 *
 * The result is an INFERRED DEFAULT: user-configured model/provider protocols
 * outrank it at resolution time, and it never rewrites the model id sent to
 * OpenCode.
 */
export function inferOpencodeProtocol(modelId: string, baseUrl?: string): Protocol {
	const product = opencodeProductForBaseUrl(baseUrl);
	const id = modelId.toLowerCase();
	if (product !== undefined) {
		const exact = EXACT_RULES.find((rule) => rule.product === product && rule.modelId === id);
		if (exact) {
			return exact.protocol;
		}
		const family = FAMILY_RULES.find((rule) => rule.match.test(id));
		const routed = family?.protocols[product];
		if (routed !== undefined) {
			return routed;
		}
	}
	return FALLBACK_PROTOCOL;
}
