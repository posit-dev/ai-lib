/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Return whether a model ID is one of OpenAI's GPT-5.6 aliases or variants.
 *
 * Bedrock Mantle prefixes OpenAI model IDs with `openai.`. Dated snapshots are
 * accepted so a provider-published immutable alias keeps the same capability as
 * its undated counterpart.
 */
export function isGpt56ModelId(modelId: string): boolean {
	return /^(?:openai\.)?gpt-5\.6(?:-(?:sol|terra|luna))?(?:-\d{4}-\d{2}-\d{2})?$/.test(modelId);
}
