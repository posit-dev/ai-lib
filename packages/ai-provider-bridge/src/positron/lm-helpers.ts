/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from "vscode";

// ============================================================================
// Type guard functions
// ============================================================================

export function isLanguageModelTextPart(
	part:
		| vscode.LanguageModelTextPart
		| vscode.LanguageModelDataPart
		| vscode.LanguageModelToolCallPart
		| vscode.LanguageModelToolResultPart
		| vscode.LanguageModelToolResultPart2,
): part is vscode.LanguageModelTextPart {
	return part instanceof vscode.LanguageModelTextPart;
}

export function isLanguageModelDataPart(
	part:
		| vscode.LanguageModelTextPart
		| vscode.LanguageModelDataPart
		| vscode.LanguageModelToolCallPart
		| vscode.LanguageModelToolResultPart
		| vscode.LanguageModelToolResultPart2,
): part is vscode.LanguageModelDataPart {
	return part instanceof vscode.LanguageModelDataPart;
}

export function isLanguageModelToolCallPart(
	part:
		| vscode.LanguageModelTextPart
		| vscode.LanguageModelDataPart
		| vscode.LanguageModelToolCallPart
		| vscode.LanguageModelToolResultPart
		| vscode.LanguageModelToolResultPart2,
): part is vscode.LanguageModelToolCallPart {
	return part instanceof vscode.LanguageModelToolCallPart;
}

export function isLanguageModelToolResultPart(
	part:
		| vscode.LanguageModelTextPart
		| vscode.LanguageModelDataPart
		| vscode.LanguageModelToolCallPart
		| vscode.LanguageModelToolResultPart
		| vscode.LanguageModelToolResultPart2,
): part is vscode.LanguageModelToolResultPart | vscode.LanguageModelToolResultPart2 {
	return (
		part instanceof vscode.LanguageModelToolResultPart ||
		part instanceof vscode.LanguageModelToolResultPart2
	);
}

// ============================================================================
// VS Code format Cache control parts
// ============================================================================

/**
 * Checks if a given language model part defines a cache breakpoint.
 */
export function isCacheBreakpointPart(part: unknown): part is vscode.LanguageModelDataPart & {
	mimeType: "cache_control";
} {
	return part instanceof vscode.LanguageModelDataPart && part.mimeType === "cache_control";
}

/**
 * Creates a language model data part that defines a cache breakpoint.
 */
export function cacheBreakpointPart(): vscode.LanguageModelDataPart {
	return vscode.LanguageModelDataPart.text("ephemeral", "cache_control");
}
