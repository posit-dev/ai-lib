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
 * access); unknown ids get conservative defaults: chat + tools, no vision,
 * and no protocol stamp, so the chat client falls back to its
 * constructor-default wire protocol.
 */

import type { Protocol } from "../vocabulary.js";

export interface OpencodeModelCapabilities {
	family: string;
	maxInputTokens: number;
	maxOutputTokens: number;
	supportsTools: boolean;
	supportsImages: boolean;
	/**
	 * Wire-protocol stamp for probe-verified models. Absent means "no routing
	 * decision" — the client's constructor-default `apiMode` applies.
	 * `openai-responses` is stamped only where a live probe verified the
	 * `/responses` route actually serves the model (none so far: every
	 * probeable model returned 500 on `/responses`).
	 */
	protocol?: Protocol;
}

/**
 * Conservative unknown-model defaults. Chat Completions is the only
 * probe-verified inference route on both products, so tools are assumed and
 * no protocol is stamped.
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
