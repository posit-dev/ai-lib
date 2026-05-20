/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025-2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Curated OpenAI model display names
 * Maps model ID -> human-readable name
 *
 * Maintained manually based on https://platform.openai.com/docs/models
 * Updated: March 2026
 */
export const OPENAI_MODEL_NAMES: Record<string, string> = {
	// GPT-5 series
	"gpt-5": "GPT-5",
	"gpt-5-chat-latest": "GPT-5 Chat Latest",
	"gpt-5.1": "GPT-5.1",
	"gpt-5.2": "GPT-5.2",
	"gpt-5.3-chat-latest": "GPT-5.3 Chat Latest",
	"gpt-5.3-codex": "GPT-5.3 Codex",
	"gpt-5.4": "GPT-5.4",
	"gpt-5.4-mini": "GPT-5.4 Mini",
	"gpt-5.4-nano": "GPT-5.4 Nano",
	"gpt-5.4-pro": "GPT-5.4 Pro",
	"gpt-5-mini": "GPT-5 Mini",
	"gpt-5-nano": "GPT-5 Nano",
	"gpt-5-pro": "GPT-5 Pro",
	"gpt-5-codex": "GPT-5 Codex",
	"gpt-5-search-api": "GPT-5 Search API",

	"gpt-5.1-chat-latest": "GPT-5.1 Chat Latest",
	"gpt-5.1-codex": "GPT-5.1 Codex",
	"gpt-5.1-codex-mini": "GPT-5.1 Codex Mini",
	"gpt-5.1-codex-max": "GPT-5.1 Codex Max",

	"gpt-5.2-chat-latest": "GPT-5.2 Chat Latest",
	"gpt-5.2-codex": "GPT-5.2 Codex",
	"gpt-5.2-pro": "GPT-5.2 Pro",

	// GPT-4.1 Series (April 2025)
	"gpt-4.1": "GPT-4.1",
	"gpt-4.1-mini": "GPT-4.1 Mini",
	"gpt-4.1-nano": "GPT-4.1 Nano",
	"gpt-4.5-preview": "GPT-4.5 Preview",

	// GPT-4o series
	"gpt-4o": "GPT-4o",
	"gpt-4o-mini": "GPT-4o Mini",
	"gpt-4o-search-preview": "GPT-4o Search Preview",
	"gpt-4o-mini-search-preview": "GPT-4o Mini Search Preview",
	"gpt-4o-audio-preview": "GPT-4o Audio Preview",
	"gpt-4o-mini-audio-preview": "GPT-4o Mini Audio Preview",
	"gpt-4o-realtime-preview": "GPT-4o Realtime Preview",
	"gpt-4o-mini-realtime-preview": "GPT-4o Mini Realtime Preview",
	"gpt-4o-transcribe": "GPT-4o Transcribe",
	"gpt-4o-transcribe-diarize": "GPT-4o Transcribe Diarize",
	"gpt-4o-mini-transcribe": "GPT-4o Mini Transcribe",
	"gpt-4o-mini-tts": "GPT-4o Mini TTS",

	// o-series (reasoning models)
	o1: "o1",
	"o1-pro": "o1 Pro",
	"o1-preview": "o1 Preview",
	"o1-mini": "o1 Mini",
	o3: "o3",
	"o3-mini": "o3 Mini",
	"o3-pro": "o3 Pro",
	"o3-deep-research": "o3 Deep Research",
	"o4-mini": "o4 Mini",
	"o4-mini-deep-research": "o4 Mini Deep Research",

	// Legacy (for backward compatibility)
	"gpt-4": "GPT-4",
	"gpt-4-turbo": "GPT-4 Turbo",
	"gpt-4-turbo-preview": "GPT-4 Turbo Preview",
	"gpt-3.5-turbo": "GPT-3.5 Turbo",
};

const MONTH_NAMES = [
	"Jan",
	"Feb",
	"Mar",
	"Apr",
	"May",
	"Jun",
	"Jul",
	"Aug",
	"Sep",
	"Oct",
	"Nov",
	"Dec",
];

function formatSnapshotDate(year: string, month: string, day: string): string {
	const monthName = MONTH_NAMES[Number(month) - 1];
	const dayNumber = Number(day);
	return `${monthName} ${dayNumber}, ${year}`;
}

/**
 * Get display name for an OpenAI model
 * Falls back to ID if not in lookup table
 */
export function getOpenAIModelName(modelId: string): string {
	const name = OPENAI_MODEL_NAMES[modelId];
	if (name) {
		return name;
	}

	const snapshotMatch = modelId.match(/-(\d{4})-(\d{2})-(\d{2})$/);
	if (snapshotMatch) {
		const [snapshotSuffix, year, month, day] = snapshotMatch;
		const baseId = modelId.slice(0, -snapshotSuffix.length);
		const baseName = OPENAI_MODEL_NAMES[baseId];
		if (baseName) {
			return `${baseName} (${formatSnapshotDate(year, month, day)})`;
		}
	}

	return modelId;
}
