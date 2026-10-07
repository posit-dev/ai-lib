/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bare-host base URL correction policy.
 *
 * `@ai-sdk/*` providers expect `baseURL` to already include the version segment
 * (`/v1`, `/v1beta`) and append only the operation path, so a bare host like
 * `https://api.anthropic.com` 404s. Historically Positron's `authentication.*`
 * settings shipped such bare hosts as defaults; the config read seams correct
 * those values here, and consumers (packages/positron) use the same helper to
 * rewrite the user's setting on disk. Model clients trust the base URLs they
 * are given — there is no chat-time normalization.
 *
 * Lives in ai-config (the pure entry) so the config pipeline — including the
 * legacy Positron settings translator — can apply the correction without an
 * `ai-provider-bridge` import. The bridge imports these constants from here.
 */

import type { BuiltinProviderId } from "./vocabulary.js";

/** Anthropic public API host. `@ai-sdk/anthropic` expects baseURL to include `/v1`. */
export const ANTHROPIC_HOST = "https://api.anthropic.com";
/** Version segment `@ai-sdk/anthropic` expects appended to the host. */
export const ANTHROPIC_API_VERSION = "v1";

/** OpenAI public API host. `@ai-sdk/openai` expects baseURL to include `/v1`. */
export const OPENAI_HOST = "https://api.openai.com";
/** Version segment `@ai-sdk/openai` expects appended to the host. */
export const OPENAI_API_VERSION = "v1";

/** Gemini public API host. `@ai-sdk/google` expects baseURL to include `/v1beta`. */
export const GEMINI_HOST = "https://generativelanguage.googleapis.com";
/** Version segment `@ai-sdk/google` expects appended to the host. */
export const GEMINI_API_VERSION = "v1beta";

/**
 * Hosted Portkey canonical HTTPS origin. Hosted classification in
 * `checkPortkeyConnection` and the bridge's `resolvePortkeyConnection` is
 * **exact-origin** against this value: only `https://api.portkey.ai` (default
 * port) is hosted — the canonical hostname under any other scheme or port is
 * a local error. Any other host is a gateway: self-hosted (upstream key) by
 * default, or a Portkey gateway when the key type is explicitly `portkey`.
 */
export const PORTKEY_HOST = "https://api.portkey.ai";
/** Version segment of Portkey's hosted API root. */
export const PORTKEY_API_VERSION = "v1";
/**
 * The hosted Portkey base URL. This is a provider-boundary constant, NOT a
 * `PROVIDER_CONNECTION_DEFAULTS` entry: Portkey's base URL is **required**
 * (it is where the stored key is sent, and when no key type is set it implies
 * what that key is — a Portkey API key for hosted, an upstream's key for any
 * other URL; an explicit key type overrides the inference for non-hosted
 * URLs), so a silent default would redirect or reinterpret the secret. UI configure forms prefill and explicitly save this
 * value; env-only configs set `PORTKEY_BASE_URL`. Exported from the pure
 * (browser-safe) entry so hosts can re-export it to their UI layers.
 */
export const PORTKEY_HOSTED_BASE_URL = `${PORTKEY_HOST}/${PORTKEY_API_VERSION}`;

/** Canonical OpenRouter API root used by both model discovery and chat. */
export const OPENROUTER_DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Canonical OpenCode host, the shared root of the two product endpoints
 * below. OpenCode's hosted model services (Go and Zen) require every
 * inference request to carry a stable conversation identity in the
 * `x-opencode-session` header; the built-in `opencode` provider applies that
 * header itself (per request, from the host's root conversation identity), so
 * this constant feeds only the endpoint literals — nothing matches on it.
 */
export const OPENCODE_HOST = "https://opencode.ai";
/** OpenCode Go API root (OpenAI-style `/v1` surface). */
export const OPENCODE_GO_BASE_URL = `${OPENCODE_HOST}/zen/go/v1`;
/** OpenCode Zen API root (OpenAI-style `/v1` surface). */
export const OPENCODE_ZEN_BASE_URL = `${OPENCODE_HOST}/zen/v1`;

/**
 * The OpenCode hosted products selectable on the single built-in `opencode`
 * provider. The choice is persisted as the scalar `providers.opencode.product`
 * field (never as a URL) so the endpoint literals below stay owned by this
 * catalog. Default product: `go` (the subscription product; Zen remains
 * selectable per user).
 */
export const OPENCODE_PRODUCTS = ["go", "zen"] as const;

/** An OpenCode hosted product selectable on the built-in `opencode` provider. */
export type OpencodeProduct = (typeof OPENCODE_PRODUCTS)[number];

/**
 * Product → API root. The catalog defaults and `resolveConnection`'s product
 * selection share this one source of truth.
 */
export const OPENCODE_PRODUCT_BASE_URLS: Readonly<Record<OpencodeProduct, string>> = {
	go: OPENCODE_GO_BASE_URL,
	zen: OPENCODE_ZEN_BASE_URL,
};

/** The default OpenCode product when `providers.opencode.product` is unset. */
export const OPENCODE_DEFAULT_PRODUCT: OpencodeProduct = "go";

/**
 * Normalize an OpenRouter host or API-root URL to the SDK's `/api/v1` base.
 * Other paths are preserved after ordinary whitespace/trailing-slash cleanup.
 */
export function normalizeOpenRouterBaseUrl(url?: string): string {
	const candidate = (url?.trim() || OPENROUTER_DEFAULT_BASE_URL).replace(/\/+$/, "");
	return candidate.endsWith("/api/v1") ? candidate : `${candidate}/api/v1`;
}

/**
 * LM Studio default local server host. Configured endpoints include the `/v1`
 * segment (OpenAI-compatible convention); the bare default host is corrected
 * at the config read seam (`LocalProviderManager.getEndpoint`) for backward
 * compatibility with previously stored endpoints.
 */
export const LMSTUDIO_HOST = "http://localhost:1234";
/** Version segment LM Studio's OpenAI-compatible API expects appended to the host. */
export const LMSTUDIO_API_VERSION = "v1";

/** Providers whose public API requires a version segment the SDK won't add. */
const KNOWN_HOSTS: Partial<Record<BuiltinProviderId, { host: string; version: string }>> = {
	anthropic: { host: ANTHROPIC_HOST, version: ANTHROPIC_API_VERSION },
	openai: { host: OPENAI_HOST, version: OPENAI_API_VERSION },
	gemini: { host: GEMINI_HOST, version: GEMINI_API_VERSION },
	lmstudio: { host: LMSTUDIO_HOST, version: LMSTUDIO_API_VERSION },
};

/**
 * Correct a bare known-provider host to its versioned form; return anything
 * else unchanged.
 *
 * Matching is tolerant: the input is compared after trimming whitespace and
 * trailing slashes, so `"https://api.anthropic.com/"` still corrects to
 * `"https://api.anthropic.com/v1"`. But a non-matching input is returned
 * **byte-for-byte** — no whitespace or trailing-slash cleanup — so
 * `result !== url` means precisely "bare-host fix applied". Callers use that
 * identity check directly as the write-back / notification criterion.
 */
export function normalizeBaseUrlForProvider(providerId: BuiltinProviderId, url: string): string {
	const known = KNOWN_HOSTS[providerId];
	if (!known) return url;

	const candidate = url.trim().replace(/\/+$/, "");
	if (candidate === known.host) {
		return `${known.host}/${known.version}`;
	}
	return url;
}

const FOUNDRY_OPENAI_PATH = "/openai";
const FOUNDRY_V1_PATH = `${FOUNDRY_OPENAI_PATH}/v1`;
const FOUNDRY_DEPLOYMENTS_PATH = `${FOUNDRY_OPENAI_PATH}/deployments`;

/** Index of the first `path` in `url` that ends at a path-segment boundary, or -1. */
function pathSegmentIndex(url: string, path: string): number {
	for (let i = url.indexOf(path); i !== -1; i = url.indexOf(path, i + 1)) {
		const next = url.charAt(i + path.length);
		if (next === "" || next === "/") return i;
	}
	return -1;
}

/**
 * Normalize a Microsoft Foundry endpoint to its `/openai/v1` base URL: strips
 * the query string, trailing slashes, any `/openai/deployments/...` suffix,
 * any operation path after `/openai/v1` that users paste from the portal, and
 * a bare trailing `/openai`, so the suffix is never doubled.
 * Empty input stays empty.
 */
export function normalizeFoundryBaseUrl(rawUrl: string): string {
	let url = rawUrl.trim();
	if (!url) return "";
	const suffixIndex = url.search(/[?#]/);
	if (suffixIndex !== -1) url = url.substring(0, suffixIndex);
	url = url.replace(/\/+$/, "");
	if (!url) return "";
	const deploymentIndex = pathSegmentIndex(url, FOUNDRY_DEPLOYMENTS_PATH);
	if (deploymentIndex !== -1) url = url.substring(0, deploymentIndex);
	const v1Index = pathSegmentIndex(url, FOUNDRY_V1_PATH);
	if (v1Index !== -1) url = url.substring(0, v1Index + FOUNDRY_V1_PATH.length);
	if (url.endsWith(FOUNDRY_OPENAI_PATH)) url = url.slice(0, -FOUNDRY_OPENAI_PATH.length);
	if (!url.endsWith(FOUNDRY_V1_PATH)) url += FOUNDRY_V1_PATH;
	return url;
}
