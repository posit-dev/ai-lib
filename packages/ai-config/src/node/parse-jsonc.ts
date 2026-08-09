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
		const { line, column } = lineColumnAt(text, first.offset);
		throw new SyntaxError(`${printParseErrorCode(first.error)} at line ${line}, column ${column}`);
	}

	return tree === undefined ? undefined : getNodeValue(tree);
}

/** Convert a character offset into a 1-based line/column pair. */
function lineColumnAt(text: string, offset: number): { line: number; column: number } {
	let line = 1;
	let lineStart = 0;
	const end = Math.min(offset, text.length);
	for (let i = 0; i < end; i++) {
		const code = text.charCodeAt(i);
		// jsonc-parser treats CR, LF, and CRLF as line breaks.
		if (code === 10 || code === 13) {
			if (code === 13 && text.charCodeAt(i + 1) === 10) i++; // CRLF is one break
			line++;
			lineStart = i + 1;
		}
	}
	return { line, column: offset - lineStart + 1 };
}
