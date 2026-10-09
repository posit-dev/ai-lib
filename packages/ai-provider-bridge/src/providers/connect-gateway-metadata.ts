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
