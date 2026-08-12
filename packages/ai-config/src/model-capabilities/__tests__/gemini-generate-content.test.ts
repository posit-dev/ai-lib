/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { getGeminiGenerateContentProfile } from "../gemini-generate-content.js";

describe("getGeminiGenerateContentProfile", () => {
	it("normalizes bare, prefixed, and Databricks endpoint-name spellings to one variant", () => {
		const variants = [
			"gemini-2.5-pro",
			"google/gemini-2.5-pro",
			"databricks-gemini-2-5-pro",
			"system.ai.gemini-2-5-pro",
			"GEMINI-2.5-PRO",
		].map((id) => getGeminiGenerateContentProfile(id)?.variant);

		expect(variants).toEqual(["2.5-pro", "2.5-pro", "2.5-pro", "2.5-pro", "2.5-pro"]);
	});

	it("drops preview/latest suffixes from the reported variant", () => {
		expect(getGeminiGenerateContentProfile("gemini-3-pro-preview")?.variant).toBe("3-pro");
	});

	it("returns undefined for ids that are not positively reconstructable", () => {
		for (const id of [
			"gemini-2.0-flash", // recognized as Gemini, no known thinking controls
			"gemini-experimental",
			"my-gemini-endpoint", // arbitrary external endpoint name
			"gpt-5",
			"",
		]) {
			expect(getGeminiGenerateContentProfile(id), id).toBeUndefined();
		}
	});

	it("uses numeric budgets for 2.5 and categorical levels for 3.x", () => {
		expect(getGeminiGenerateContentProfile("gemini-2.5-flash")?.thinking.control).toBe("budget");
		expect(getGeminiGenerateContentProfile("gemini-3-pro-preview")?.thinking.control).toBe("level");
	});

	it("advertises 'off' only where thinking can be disabled", () => {
		// 2.5 Pro cannot disable thinking (documented minimum budget 128).
		expect(getGeminiGenerateContentProfile("gemini-2.5-pro")?.thinkingEffortLevels).not.toContain(
			"off",
		);
		expect(getGeminiGenerateContentProfile("gemini-2.5-flash")?.thinkingEffortLevels).toContain(
			"off",
		);
		expect(
			getGeminiGenerateContentProfile("gemini-2.5-flash-lite")?.thinkingEffortLevels,
		).toContain("off");
		// No 3.x variant can disable thinking.
		expect(
			getGeminiGenerateContentProfile("gemini-3-flash-preview")?.thinkingEffortLevels,
		).not.toContain("off");
	});

	it("advertises exactly the levels a level-controlled variant accepts", () => {
		const proProfile = getGeminiGenerateContentProfile("gemini-3-pro-preview");
		expect(proProfile?.thinking).toEqual({ control: "level", levels: ["low", "high"] });
		expect(proProfile?.thinkingEffortLevels).toEqual(["low", "high"]);

		expect(getGeminiGenerateContentProfile("gemini-3.6-flash")?.thinkingEffortLevels).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
		]);
	});

	it("keeps every budget wire value inside the variant's documented range", () => {
		const ranges: Record<string, { min: number; max: number }> = {
			"gemini-2.5-pro": { min: 128, max: 32_768 },
			"gemini-2.5-flash": { min: 0, max: 24_576 },
			"gemini-2.5-flash-lite": { min: 512, max: 24_576 },
		};
		for (const [id, range] of Object.entries(ranges)) {
			const thinking = getGeminiGenerateContentProfile(id)?.thinking;
			expect(thinking?.control, id).toBe("budget");
			if (thinking?.control !== "budget") continue;
			const { low, medium, high } = thinking.budgets;
			expect([low, medium, high], id).toEqual([low, medium, high].slice().sort((a, b) => a - b));
			expect(low, id).toBeGreaterThanOrEqual(range.min);
			expect(high, id).toBeLessThanOrEqual(range.max);
		}
	});
});
