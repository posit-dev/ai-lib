/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { isGpt56ModelId } from "../gpt-5-6";

describe("isGpt56ModelId", () => {
	it.each([
		"gpt-5.6",
		"gpt-5.6-sol",
		"gpt-5.6-terra",
		"gpt-5.6-luna",
		"openai.gpt-5.6",
		"openai.gpt-5.6-sol",
		"openai.gpt-5.6-terra",
		"openai.gpt-5.6-luna",
		"gpt-5.6-sol-2026-07-23",
	])("accepts %s", (modelId) => {
		expect(isGpt56ModelId(modelId)).toBe(true);
	});

	it.each(["gpt-5.5", "gpt-5.60", "gpt-5.6-pro", "vendor.gpt-5.6-sol"])("rejects %s", (modelId) => {
		expect(isGpt56ModelId(modelId)).toBe(false);
	});
});
