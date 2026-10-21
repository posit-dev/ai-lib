/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import {
	isRecognizedSnowflakeCortexModel,
	SNOWFLAKE_CORTEX_CATALOG,
	snowflakeCortexModelName,
} from "../snowflake-cortex-helpers.js";

describe("isRecognizedSnowflakeCortexModel", () => {
	it.each(["claude-opus-4-8", "claude-sonnet-5-5", "openai-gpt-6.1-sol", "openai-gpt-5.4"])(
		"recognizes %s",
		(id) => {
			expect(isRecognizedSnowflakeCortexModel(id)).toBe(true);
		},
	);

	it.each([
		// Claude-shaped, but no explicit Anthropic capability rule matches.
		"claude-opus-9",
		// The OpenAI table doesn't know the stripped id.
		"openai-1p-gpt-5.6-sol",
		// Known to the OpenAI table, but not a Cortex `openai-` id.
		"gpt-5.4",
		"llama4-maverick",
		"mistral-large2",
		"deepseek-r1",
		"snowflake-arctic",
	])("does not recognize %s", (id) => {
		expect(isRecognizedSnowflakeCortexModel(id)).toBe(false);
	});

	it("recognizes every fallback id", () => {
		expect(SNOWFLAKE_CORTEX_CATALOG.filter((id) => !isRecognizedSnowflakeCortexModel(id))).toEqual(
			[],
		);
	});
});

describe("snowflakeCortexModelName", () => {
	it.each([
		["claude-opus-4-8", "Claude Opus 4.8"],
		["claude-sonnet-5-5", "Claude Sonnet 5.5"],
		["claude-opus-5", "Claude Opus 5"],
		["openai-gpt-6.1-sol", "GPT-6.1 Sol"],
		["openai-gpt-6-astra", "GPT-6 Astra"],
		["openai-gpt-5.4", "GPT-5.4"],
		// A dated suffix is not a version segment.
		["claude-sonnet-4-5-20250929", "Claude Sonnet 4.5 20250929"],
	])("names %s %j", (id, name) => {
		expect(snowflakeCortexModelName(id)).toBe(name);
	});
});
