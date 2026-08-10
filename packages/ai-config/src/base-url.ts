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
 * Hosted Portkey canonical HTTPS origin. Hosted-vs-OSS classification in the
 * bridge's `resolvePortkeyConnection` is **exact-origin** against this value:
 * only `https://api.portkey.ai` (default port) classifies as hosted — the
 * canonical hostname under any other scheme or port is a local error, and
 * lookalike hosts classify as OSS.
 */
export const PORTKEY_HOST = "https://api.portkey.ai";
/** Version segment of Portkey's hosted API root. */
export const PORTKEY_API_VERSION = "v1";
/**
 * The hosted Portkey base URL. This is a provider-boundary constant, NOT a
 * `PROVIDER_CONNECTION_DEFAULTS` entry: Portkey's base URL is **required**
 * (it determines what the stored key is — a Portkey API key for hosted, an
 * upstream's key for a self-hosted gateway), so a silent default would
 * reinterpret the secret. UI configure forms prefill and explicitly save this
 * value; env-only configs set `PORTKEY_BASE_URL`. Exported from the pure
 * (browser-safe) entry so hosts can re-export it to their UI layers.
 */
export const PORTKEY_HOSTED_BASE_URL = `${PORTKEY_HOST}/${PORTKEY_API_VERSION}`;

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
