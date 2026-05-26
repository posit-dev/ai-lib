/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

const SDK_MANAGED_HEADER_NAMES = new Set([
	"accept",
	"anthropic-version",
	"authorization",
	"content-type",
	"x-api-key",
]);

type HeaderSource = ConstructorParameters<typeof Headers>[0];

function isCustomHeaderAllowed(name: string, value: string): boolean {
	return value.length > 0 && !SDK_MANAGED_HEADER_NAMES.has(name.toLowerCase());
}

/**
 * Return a Headers object with user-supplied custom headers added only when
 * they are non-empty, not SDK-managed, and do not already exist in baseHeaders.
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
		if (isCustomHeaderAllowed(name, value) && !headers.has(name)) {
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
 * the cached model fetcher tests and call sites.
 */
export function additiveHeaderRecord(
	baseHeaders: Record<string, string>,
	customHeaders: Record<string, string> | undefined,
): Record<string, string> {
	const baseHeaderNames = new Set(Object.keys(baseHeaders).map((name) => name.toLowerCase()));
	const customEntries = Object.entries(customHeaders ?? {}).filter(
		([name, value]) =>
			isCustomHeaderAllowed(name, value) && !baseHeaderNames.has(name.toLowerCase()),
	);

	return customEntries.length > 0
		? { ...Object.fromEntries(customEntries), ...baseHeaders }
		: baseHeaders;
}

/**
 * Filter custom headers before passing them to an AI SDK provider's `headers`
 * option.
 *
 * Direct SDK clients do not expose their final provider-managed headers at this
 * point, so this removes known SDK-managed names and returns only safe additive
 * gateway headers. Returns undefined when no custom header remains.
 */
export function safeSdkCustomHeaders(
	customHeaders: Record<string, string> | undefined,
): Record<string, string> | undefined {
	const entries = Object.entries(customHeaders ?? {}).filter(([name, value]) =>
		isCustomHeaderAllowed(name, value),
	);

	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}
