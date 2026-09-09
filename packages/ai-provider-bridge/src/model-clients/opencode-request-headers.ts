/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenCode endpoint header policy.
 *
 * OpenCode's hosted model services (Go and Zen) require every inference
 * request to carry a stable conversation identity in the `x-opencode-session`
 * header and ask clients to identify themselves with a product User-Agent.
 * This module is the single owner of that transport policy: the endpoint
 * literals, the route matching, and the header merging.
 *
 * Scope and ownership:
 *
 * - The literals and matcher stay private to the bridge. No configuration
 *   resolver, schema, form, or host consumes them, so they are deliberately
 *   not exported from the package entrypoints. OpenCode behind another
 *   hostname (proxy/gateway aliases) is out of scope for automatic
 *   detection; supporting that would require an explicit configuration
 *   contract, not hostname inference.
 * - The policy inspects the resolved request destination without correcting
 *   or rewriting it, preserving the Base URLs invariant that clients use the
 *   supplied URL unchanged. Because per-model endpoint overrides can change
 *   the destination at request time, matching runs on the resolved URL per
 *   request, not at registration.
 * - The bridge owns *how* the identity is sent; the host owns the identity
 *   itself (`rootConversationId`) and the product User-Agent. With no root
 *   metadata the policy adds no session header and invents no fallback.
 * - Only automatically generated headers are scoped this way. Explicit
 *   custom headers on unrelated endpoints are never stripped, and an
 *   explicit custom User-Agent always wins over the host default.
 */

/** Header that carries the conversation routing identity to OpenCode. */
const SESSION_HEADER_NAME = "x-opencode-session";

const USER_AGENT_HEADER_NAME = "user-agent";

/** Canonical OpenCode host. Exact match only — no subdomain/lookalike matching. */
const OPENCODE_HOST = "opencode.ai";

/** OpenCode API roots: Go (`/zen/go/v1`) and Zen (`/zen/v1`). */
const OPENCODE_API_ROOTS = ["/zen/go/v1", "/zen/v1"] as const;

/**
 * Whether `url` resolves to a recognized OpenCode API endpoint: HTTPS on
 * exactly `opencode.ai` (default port) with an API root of `/zen/go/v1` or
 * `/zen/v1`, tolerating trailing slashes and sub-paths (e.g. the `/models`
 * discovery URL). Absent or unparsable URLs do not match.
 */
export function isOpencodeEndpoint(url: string | undefined): boolean {
	if (!url) {
		return false;
	}
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return false;
	}
	// `new URL` normalizes the default HTTPS port away, so a non-empty port
	// is always a non-default one.
	if (parsed.protocol !== "https:" || parsed.hostname !== OPENCODE_HOST || parsed.port !== "") {
		return false;
	}
	const path = parsed.pathname.replace(/\/+$/, "");
	return OPENCODE_API_ROOTS.some((root) => path === root || path.startsWith(`${root}/`));
}

/**
 * The explicit User-Agent from a custom-header map, if any: the first
 * case-insensitive `User-Agent` entry with a non-empty value.
 */
export function explicitUserAgentHeader(
	customHeaders: Record<string, string> | undefined,
): string | undefined {
	for (const [name, value] of Object.entries(customHeaders ?? {})) {
		if (name.toLowerCase() === USER_AGENT_HEADER_NAME && value.length > 0) {
			return value;
		}
	}
	return undefined;
}

export interface OpencodeHeaderPolicy {
	/** The resolved request destination (`params.baseUrl ?? client baseURL`). */
	baseUrl: string | undefined;
	/** Host-owned root conversation identity, when the request belongs to one. */
	rootConversationId?: string;
	/** Host product User-Agent (already resolved against explicit overrides). */
	userAgent?: string;
}

/**
 * Merge the OpenCode policy headers into an SDK-bound header record.
 *
 * On a matching OpenCode route:
 *
 * - With `rootConversationId`, `x-opencode-session` is set to that identity.
 *   The generated value wins: any case-variant of the header already present
 *   (a static custom-header workaround) is replaced. Without root metadata no
 *   session header is added — and an existing static one survives untouched.
 * - With `userAgent`, `User-Agent` is set only when the record does not
 *   already carry a non-empty one (an explicit custom User-Agent wins over
 *   the host default).
 *
 * On any other route the record is returned unchanged, so a user's static
 * OpenCode headers on lookalike or unrelated endpoints are preserved.
 */
export function mergeOpencodeHeaders(
	headers: Record<string, string> | undefined,
	policy: OpencodeHeaderPolicy,
): Record<string, string> | undefined {
	if (!isOpencodeEndpoint(policy.baseUrl)) {
		return headers;
	}

	const merged: Record<string, string> = {};
	let hasUserAgent = false;
	for (const [name, value] of Object.entries(headers ?? {})) {
		const lower = name.toLowerCase();
		if (lower === SESSION_HEADER_NAME && policy.rootConversationId !== undefined) {
			// The generated session value wins over any static workaround.
			continue;
		}
		if (lower === USER_AGENT_HEADER_NAME && value.length > 0) {
			hasUserAgent = true;
		}
		merged[name] = value;
	}

	if (policy.rootConversationId !== undefined) {
		merged[SESSION_HEADER_NAME] = policy.rootConversationId;
	}
	if (policy.userAgent !== undefined && !hasUserAgent) {
		merged["User-Agent"] = policy.userAgent;
	}

	return Object.keys(merged).length > 0 ? merged : undefined;
}
