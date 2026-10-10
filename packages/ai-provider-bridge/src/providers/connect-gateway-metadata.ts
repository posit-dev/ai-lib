/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/** Header Posit Connect's LLM gateway reads (and strips before the provider). */
export const GATEWAY_METADATA_HEADER = "Posit-Connect-Gateway-Metadata";

/** Workbench provides the finished header value through this environment variable. */
export const WORKBENCH_GATEWAY_METADATA_ENV = "PWB_CONNECT_GATEWAY_METADATA";

/** Keep unsafe header values from failing a chat before Connect can parse them. */
export function isSafeGatewayMetadataHeader(value: string): boolean {
	// Workbench percent-encodes UTF-8; the resulting wire value is printable ASCII.
	// Connect independently validates the format and its own 4 KiB cap.
	return value.length > 0 && value.length <= 4096 && /^[\x20-\x7e]+$/.test(value);
}

/** Keep each source's wire value intact; Connect decides which entries are valid. */
export function combineGatewayMetadataHeaders(
	workbenchValue: string | undefined,
	customHeaders: Record<string, string> | undefined,
): string | undefined {
	const configuredValues = Object.entries(customHeaders ?? {})
		.filter(([name]) => name.toLowerCase() === GATEWAY_METADATA_HEADER.toLowerCase())
		.map(([, value]) => value);
	let combined: string | undefined;
	let entries = 0;
	// Workbench goes first so a configured value cannot exceed Connect's global
	// header/entry limits and cause it to discard the entire Workbench header.
	for (const value of [workbenchValue, ...configuredValues]) {
		if (value === undefined || !isSafeGatewayMetadataHeader(value)) continue;
		const valueEntries = value.split(",").filter((entry) => entry.trim().length > 0).length;
		if (valueEntries === 0 || entries + valueEntries > 16) continue;
		if ((combined?.length ?? 0) + value.length + (combined === undefined ? 0 : 1) > 4096) continue;
		combined = combined === undefined ? value : `${combined},${value}`;
		entries += valueEntries;
	}
	return combined;
}
