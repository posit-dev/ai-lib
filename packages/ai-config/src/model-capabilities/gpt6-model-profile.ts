/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { InferredModelCapabilities } from "../types.js";

/**
 * Model traits that hold for a GPT-6 model on every endpoint that serves it.
 * Deliberately excludes token limits, routing, and web search: those are
 * endpoint policy owned by each provider helper.
 */
export type Gpt6ModelProfile = Required<
	Pick<
		InferredModelCapabilities,
		| "family"
		| "supportsTools"
		| "supportsImages"
		| "supportedInputMediaTypes"
		| "supportsToolResultImages"
		| "thinkingEffortLevels"
	>
>;

const GPT6_EFFORT_LEVELS = ["off", "low", "medium", "high", "xhigh", "max"];
// The product's "off" maps onto OpenAI's "none" effort (the OpenAI client
// omits reasoning_effort; Bedrock Mantle sends the wire value "none").
// Sources verified 2026-09-22 (Astra) and 2026-09-30 (6.1 Sol):
// https://developers.openai.com/api/docs/models/gpt-6-astra
// https://developers.openai.com/api/docs/models/gpt-6.1-sol
// Neither model offers "none", so the product must not offer "off". This is a
// model property, so it applies to every accepted suffix of these names.
const GPT6_NO_OFF_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const GPT6_NO_OFF_MODEL = /^gpt-6(?:-astra|\.1-sol)(?:-|$)/;
const IMAGE_MEDIA_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"];

/**
 * Shared GPT-6 traits for a canonical, unprefixed OpenAI model ID, or
 * `undefined` for IDs outside the GPT-6 family. Provider helpers strip any
 * vendor namespace first and layer their own endpoint limits on top.
 */
export function getGpt6ModelProfile(modelId: string): Gpt6ModelProfile | undefined {
	if (!modelId.startsWith("gpt-6")) return undefined;
	return {
		family: "gpt-6",
		supportsTools: true,
		supportsImages: true,
		supportedInputMediaTypes: IMAGE_MEDIA_TYPES,
		supportsToolResultImages: true,
		// Original Sol/Luna and unknown future GPT-6 IDs keep "off".
		thinkingEffortLevels: GPT6_NO_OFF_MODEL.test(modelId)
			? GPT6_NO_OFF_EFFORT_LEVELS
			: GPT6_EFFORT_LEVELS,
	};
}
