/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

const SDK_MANAGED_HEADER_NAMES = new Set([
	"accept",
	"anthropic-version",
	"authorization",
	"content-type",
	"x-api-key",
	"x-goog-api-key",
]);
const USER_AGENT_HEADER_NAME = "user-agent";

type HeaderSource = ConstructorParameters<typeof Headers>[0];

function isCustomHeaderAllowed(name: string, value: string): boolean {
	return value.length > 0 && !SDK_MANAGED_HEADER_NAMES.has(name.toLowerCase());
}

function mergeUserAgent(existing: string | undefined, custom: string): string {
	if (!existing) return custom;
	if (existing === custom || existing.startsWith(`${custom} `)) return existing;
	return `${custom} ${existing}`;
}

/**
 * Return a Headers object with user-supplied custom headers added only when
 * they are non-empty and not SDK-managed. Existing provider headers win on
 * collision, except User-Agent: the custom product identity is prepended to
 * the SDK's library tokens and repeated application is a no-op.
 *
 * Use this for fetch wrappers where the incoming headers may already include
 * provider/SDK-managed values such as Authorization or Content-Type.
 */
export function additiveHeaders(
	baseHeaders: HeaderSource,
	customHeaders: Record<string, string> | undefined,
): Headers {
	const headers = new Headers(baseHeaders);

	for (const [name, value] of Object.entries(customHeaders ?? {})) {
		if (!isCustomHeaderAllowed(name, value)) continue;
		if (name.toLowerCase() === USER_AGENT_HEADER_NAME) {
			headers.set(name, mergeUserAgent(headers.get(name) ?? undefined, value));
		} else if (!headers.has(name)) {
			headers.set(name, value);
		}
	}

	return headers;
}

/**
 * Return a plain header record with additive custom headers merged beneath
 * provider-created headers.
 *
 * This mirrors additiveHeaders but preserves the plain-object shape expected by
 * the cached model fetcher tests and call sites. User-Agent is the one
 * non-additive exception: a custom product identity is prepended to an existing
 * SDK value rather than discarded.
 */
export function additiveHeaderRecord(
	baseHeaders: Record<string, string>,
	customHeaders: Record<string, string> | undefined,
): Record<string, string> {
	let result = baseHeaders;

	for (const [name, value] of Object.entries(customHeaders ?? {})) {
		if (!isCustomHeaderAllowed(name, value)) continue;

		const lowerName = name.toLowerCase();
		const existingName = Object.keys(result).find(
			(candidate) => candidate.toLowerCase() === lowerName,
		);
		if (lowerName === USER_AGENT_HEADER_NAME) {
			const merged = mergeUserAgent(
				existingName === undefined ? undefined : result[existingName],
				value,
			);
			if (existingName !== undefined && result[existingName] === merged) continue;
			if (result === baseHeaders) result = { ...baseHeaders };
			result[existingName ?? name] = merged;
		} else if (existingName === undefined) {
			if (result === baseHeaders) result = { ...baseHeaders };
			result[name] = value;
		}
	}

	return result;
}

/**
 * Filter custom headers before passing them to an AI SDK provider's `headers`
 * option.
 *
 * Direct SDK clients do not expose their final provider-managed headers at this
 * point, so this removes known SDK-managed names and returns only safe additive
 * gateway headers. Returns undefined when no custom header remains. User-Agent
 * is retained so the SDK can append its own library tokens.
 */
export function safeSdkCustomHeaders(
	customHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
	const entries = Object.entries(customHeaders ?? {}).filter(([name, value]) =>
		isCustomHeaderAllowed(name, value),
	);

	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
