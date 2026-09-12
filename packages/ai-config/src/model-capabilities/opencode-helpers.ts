/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * OpenCode Go/Zen model capabilities.
 *
 * Both products expose an OpenAI-style `/v1` surface whose catalog mixes many
 * upstream vendors behind OpenCode's own model ids, so no upstream family
 * table applies. The table below contains ONLY models verified by live
 * probing (2026-09-09, Zen free tier — the probe account had no paid Go/Zen
 * access); unknown ids get conservative defaults: chat + tools, no vision.
 *
 * Capabilities are deliberately separate from ROUTING: the wire protocol a
 * model is reached over is a documented service contract owned by
 * `opencode-routing.ts`, independent of what a free-tier probe could reach.
 * This helper therefore stamps no protocol — and must not: it has no product
 * context, so an id-only answer (e.g. MiniMax, which is Messages on Go but
 * Chat Completions on Zen) would be invented rather than derived.
 */

export interface OpencodeModelCapabilities {
	family: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	supportsTools: boolean;
	supportsImages: boolean;
}

/**
 * Conservative unknown-model defaults. Chat Completions is the only
 * probe-verified inference route on both products, so tools are assumed.
 */
const DEFAULT_CAPABILITIES: OpencodeModelCapabilities = {
	family: "opencode",
	maxInputTokens: 128_000,
	maxOutputTokens: 16_384,
	supportsTools: true,
	supportsImages: false,
};

/**
 * Probe-verified per-model overrides, keyed by exact model id. An entry with
 * no overrides still records that the model was probe-verified (chat) — keep
 * entries minimal rather than restating the defaults.
 */
const CAPABILITY_TABLE: Record<string, Partial<OpencodeModelCapabilities>> = {
	// Zen free tier, verified 2026-09-09: chat, SSE streaming, tool calling.
	"big-pickle": {},
	// Zen free tier, verified 2026-09-09: chat; image_url input accepted and
	// described (vision).
	"mimo-v2.5-free": { supportsImages: true },
	// Zen free tier, verified 2026-09-09: chat.
	"nemotron-3-ultra-free": {},
};

/**
 * Capabilities for an OpenCode-hosted model id: probe-verified overrides over
 * conservative defaults. Unknown ids receive the defaults unchanged.
 */
export function getOpencodeModelCapabilities(modelId: string): OpencodeModelCapabilities {
	return { ...DEFAULT_CAPABILITIES, ...CAPABILITY_TABLE[modelId] };
}
