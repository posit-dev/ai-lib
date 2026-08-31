/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Shared structural guard for JSON object values. Internal to ai-config —
 * not exported from any entrypoint.
 */

/**
 * Whether `value` is a JSON object: a non-null, non-array object. Null-prototype
 * objects (which JSONC parsing produces) qualify — "plain" refers to the JSON
 * data shape, not the prototype chain.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
