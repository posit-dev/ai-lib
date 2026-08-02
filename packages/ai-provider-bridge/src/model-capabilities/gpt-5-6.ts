/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Return whether a model ID is one of OpenAI's GPT-5.6 aliases or variants.
 *
 * Bedrock Mantle prefixes OpenAI model IDs with `openai.`. Dated snapshots are
 * accepted only for the named Sol/Terra/Luna tiers. A dated bare alias is not a
 * documented model form and cannot be mapped safely to one tier's pricing and
 * capabilities.
 */
export function isGpt56ModelId(modelId: string): boolean {
	return /^(?:openai\.)?gpt-5\.6(?:-(?:sol|terra|luna)(?:-\d{4}-\d{2}-\d{2})?)?$/.test(modelId);
}
