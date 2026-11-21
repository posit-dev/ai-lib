/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { getGeminiModelCapabilities } from "../gemini-helpers.js";

describe("getGeminiModelCapabilities", () => {
	it.each([
		{ name: "a later minor", id: "gemini-3.9-flash", donor: "gemini-3.8-flash" },
		{ name: "a two-digit minor", id: "gemini-3.10-flash", donor: "gemini-3.8-flash" },
		{ name: "a major bump", id: "gemini-4-pro", donor: "gemini-3.1-pro" },
		{ name: "Flash-Lite", id: "gemini-3.5-flash-lite", donor: "gemini-3.1-flash-lite" },
		{ name: "a Gemini 4 name", id: "gemini-4.1-neon", donor: "gemini-4-neon" },
		{
			name: "a suffixed Gemini 4 name",
			id: "gemini-4-argon-cyber-permissive",
			donor: "gemini-4-argon",
		},
		{
			name: "a dated suffix",
			id: "gemini-2.5-flash-preview-09-2025",
			donor: "gemini-2.5-flash",
		},
	])("inherits the nearest older same-variant entry for $name", ({ id, donor }) => {
		// Unrecognized ids share the defaults, so equality alone proves nothing.
		expect(getGeminiModelCapabilities(donor)?.family).toBeDefined();
		expect(getGeminiModelCapabilities(id)).toEqual(getGeminiModelCapabilities(donor));
	});

	it("gives an unknown variant the defaults with no levels", () => {
		const caps = getGeminiModelCapabilities("gemini-4-ultra");
		expect(caps?.family).toBeUndefined();
		expect(caps?.thinkingEffortLevels).toBeUndefined();
	});

	it("keeps the version-family result for ids with no recognized variant", () => {
		const caps = getGeminiModelCapabilities("gemini-3.5-live-translate-preview");
		expect(caps?.family).toBe("gemini-3");
		expect(caps?.thinkingEffortLevels).toEqual(["minimal", "low", "medium", "high"]);
	});
});
