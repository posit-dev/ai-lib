/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Bare-host base URL correction policy.
 *
 * `@ai-sdk/*` providers expect `baseURL` to already include the version segment
 * (`/v1`, `/v1beta`) and append only the operation path, so a bare host like
 * `https://api.anthropic.com` 404s. Historically Positron's `authentication.*`
 * settings shipped such bare hosts as defaults; consumers (packages/positron)
 * use this helper to correct those values at the config read seam and to
 * rewrite the user's setting on disk. The bridge itself trusts the base URLs
 * it is given — there is no chat-time normalization.
 *
 * Lives in its own module (not `utils.ts`) because it imports the host
 * constants from the client modules, which themselves import `utils`.
 */

import { ANTHROPIC_API_VERSION, ANTHROPIC_HOST } from "./model-clients/AnthropicClient";
import { GEMINI_API_VERSION, GEMINI_HOST } from "./model-clients/GeminiClient";
import { OPENAI_API_VERSION, OPENAI_HOST } from "./model-clients/OpenAIClient";
import type { ProviderId } from "./types";

/** Providers whose public API requires a version segment the SDK won't add. */
const KNOWN_HOSTS: Partial<Record<ProviderId, { host: string; version: string }>> = {
	anthropic: { host: ANTHROPIC_HOST, version: ANTHROPIC_API_VERSION },
	openai: { host: OPENAI_HOST, version: OPENAI_API_VERSION },
	gemini: { host: GEMINI_HOST, version: GEMINI_API_VERSION },
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
export function normalizeBaseUrlForProvider(providerId: ProviderId, url: string): string {
	const known = KNOWN_HOSTS[providerId];
	if (!known) return url;

	const candidate = url.trim().replace(/\/+$/, "");
	if (candidate === known.host) {
		return `${known.host}/${known.version}`;
	}
	return url;
}
