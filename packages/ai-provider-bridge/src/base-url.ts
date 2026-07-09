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
 * This module owns the host/version constants (the client modules re-export
 * them) and must stay dependency-light: it is reachable from the bridge ROOT
 * entrypoint, which browser bundles import (via @assistant/core re-exports) —
 * importing the client modules here would drag their Node-only dependencies
 * (`crypto` via ai-sdk-helpers) into browser code.
 */

import type { ProviderId } from "./types";

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
 * LM Studio default local server host. Configured endpoints include the `/v1`
 * segment (OpenAI-compatible convention); the bare default host is corrected
 * at the config read seam (`LocalProviderManager.getEndpoint`) for backward
 * compatibility with previously stored endpoints.
 */
export const LMSTUDIO_HOST = "http://localhost:1234";
/** Version segment LM Studio's OpenAI-compatible API expects appended to the host. */
export const LMSTUDIO_API_VERSION = "v1";

/** Providers whose public API requires a version segment the SDK won't add. */
const KNOWN_HOSTS: Partial<Record<ProviderId, { host: string; version: string }>> = {
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
export function normalizeBaseUrlForProvider(providerId: ProviderId, url: string): string {
	const known = KNOWN_HOSTS[providerId];
	if (!known) return url;

	const candidate = url.trim().replace(/\/+$/, "");
	if (candidate === known.host) {
		return `${known.host}/${known.version}`;
	}
	return url;
}
