/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Parse JSONC consistently for ai-config's user-editable files.
 *
 * This helper is intentionally internal to the Node entry's implementation:
 * callers use the package's load and mutation seams rather than parsing files
 * themselves.
 */

import { getNodeValue, parseTree, type ParseError, printParseErrorCode } from "jsonc-parser";

/** Parse JSONC into null-prototype objects, throwing `SyntaxError` on invalid input. */
export function parseJsonc(text: string): unknown {
	const errors: ParseError[] = [];
	const tree = parseTree(text, errors, { allowTrailingComma: true });

	if (errors.length > 0) {
		const first = errors[0];
		throw new SyntaxError(`${printParseErrorCode(first.error)} at offset ${first.offset}`);
	}

	return tree === undefined ? undefined : getNodeValue(tree);
}
