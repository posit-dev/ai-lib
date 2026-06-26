/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { Logger } from "../types";

/**
 * Ensures data is converted to a proper Uint8Array.
 *
 * When binary data crosses process/context boundaries in VS Code (e.g.,
 * extension host ↔ webview), Node.js Buffer objects can be serialized into
 * plain JavaScript objects like `{type: "Buffer", data: [...]}` instead of
 * remaining as Uint8Array instances. This function normalizes these various
 * serialized formats back into proper Uint8Array objects.
 *
 * @param data - Data from LanguageModelDataPart which may be in various formats
 * due to serialization
 * @param logger - Logger for logging conversion failures
 * @returns Proper Uint8Array
 */
export function ensureUint8Array(data: Uint8Array, logger: Logger): Uint8Array {
	// If it's already a proper Uint8Array, return as-is
	if (data instanceof Uint8Array) {
		return data;
	}

	// Handle Node.js Buffer (which extends Uint8Array but may serialize differently)
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	const dataAny = data as any;

	// Check if it's a serialized Buffer object: {type: "Buffer", data: [...]}
	if (
		typeof dataAny === "object" &&
		dataAny !== null &&
		dataAny.type === "Buffer" &&
		Array.isArray(dataAny.data)
	) {
		return new Uint8Array(dataAny.data);
	}

	// Check if it has a .data property that's an array (alternative Buffer format)
	if (
		typeof dataAny === "object" &&
		dataAny !== null &&
		"data" in dataAny &&
		Array.isArray(dataAny.data)
	) {
		return new Uint8Array(dataAny.data);
	}

	// If it's array-like, try to convert it
	if (ArrayBuffer.isView(dataAny)) {
		return new Uint8Array(dataAny.buffer, dataAny.byteOffset, dataAny.byteLength);
	}

	// Last resort: if it's an ArrayBuffer, wrap it
	if (dataAny instanceof ArrayBuffer) {
		return new Uint8Array(dataAny);
	}

	// If we can't convert it, log and return an empty array
	logger.warn(
		"Failed to convert data to Uint8Array, unexpected data format. Returning empty array.",
		{ dataType: typeof dataAny, constructor: dataAny?.constructor?.name },
		dataAny,
	);
	return new Uint8Array(0);
}
