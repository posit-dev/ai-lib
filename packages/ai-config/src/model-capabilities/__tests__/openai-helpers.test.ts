/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { getOpenAIModelCapabilities } from "../openai-helpers.js";

describe("getOpenAIModelCapabilities", () => {
	it.each([
		{ id: "gpt-7", donor: "gpt-6.1-sol" },
		{ id: "gpt-10-pro-2030-01-01", donor: "gpt-6.1-sol" },
		{ id: "gpt-7-mini", donor: "gpt-5.4-mini" },
		{ id: "gpt-7.1-nano", donor: "gpt-5.4-nano" },
	])("resolves future generation $id as $donor", ({ id, donor }) => {
		expect(getOpenAIModelCapabilities(id)).toEqual(getOpenAIModelCapabilities(donor));
	});
});
