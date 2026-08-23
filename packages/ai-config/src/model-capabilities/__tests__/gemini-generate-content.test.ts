/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { getGeminiGenerateContentProfile } from "../gemini-generate-content.js";

type NormalizationCase = {
	name: string;
	id: string;
};

const NORMALIZATION_CASES = [
	{ name: "bare id", id: "gemini-2.5-pro" },
	{ name: "provider-prefixed id", id: "google/gemini-2.5-pro" },
	{ name: "Databricks endpoint name", id: "databricks-gemini-2-5-pro" },
	{ name: "Unity Catalog system-model name", id: "system.ai.gemini-2-5-pro" },
	{ name: "uppercase id", id: "GEMINI-2.5-PRO" },
] satisfies readonly NormalizationCase[];

type UndocumentedVariantCase = {
	name: string;
	id: string;
};

const UNDOCUMENTED_VARIANT_CASES = [
	{ name: "undocumented 3.7 Flash", id: "gemini-3.7-flash" },
	{ name: "undocumented 3.9 Pro", id: "gemini-3.9-pro" },
] satisfies readonly UndocumentedVariantCase[];

type BudgetRangeCase = {
	name: string;
	id: string;
	min: number;
	max: number;
};

const BUDGET_RANGE_CASES = [
	{ name: "2.5 Pro", id: "gemini-2.5-pro", min: 128, max: 32_768 },
	{ name: "2.5 Flash", id: "gemini-2.5-flash", min: 0, max: 24_576 },
	{ name: "2.5 Flash-Lite", id: "gemini-2.5-flash-lite", min: 512, max: 24_576 },
] satisfies readonly BudgetRangeCase[];

describe("getGeminiGenerateContentProfile", () => {
	it.each(NORMALIZATION_CASES)("normalizes a $name to the 2.5 Pro variant", ({ id }) => {
		expect(getGeminiGenerateContentProfile(id)?.variant).toBe("2.5-pro");
	});

	it("drops preview/latest suffixes from the reported variant", () => {
		expect(getGeminiGenerateContentProfile("gemini-3-pro-preview")?.variant).toBe("3-pro");
	});

	it("returns undefined for a known Gemini variant without thinking controls", () => {
		expect(getGeminiGenerateContentProfile("gemini-2.0-flash")).toBeUndefined();
	});

	it("rejects a malformed Gemini signature", () => {
		expect(getGeminiGenerateContentProfile("gemini-experimental")).toBeUndefined();
	});

	it("rejects a misleading embedded Gemini prefix in an arbitrary endpoint name", () => {
		expect(getGeminiGenerateContentProfile("my-gemini-endpoint")).toBeUndefined();
	});

	// Level sets differ per 3.x variant, so there is no generic rule to inherit:
	// recognition must be explicit.
	it.each(UNDOCUMENTED_VARIANT_CASES)("returns undefined for $name", ({ id }) => {
		expect(getGeminiGenerateContentProfile(id)).toBeUndefined();
	});

	it("returns undefined for non-Gemini and empty ids", () => {
		expect(getGeminiGenerateContentProfile("gpt-5")).toBeUndefined();
		expect(getGeminiGenerateContentProfile("")).toBeUndefined();
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

	it("matches the narrower Flash-Lite Image rule before plain Flash-Lite", () => {
		// The image variant documents only minimal/high; plain 3.1 Flash-Lite
		// documents all four. Rule order is what keeps them apart.
		expect(
			getGeminiGenerateContentProfile("gemini-3.1-flash-lite-image")?.thinkingEffortLevels,
		).toEqual(["minimal", "high"]);
		expect(getGeminiGenerateContentProfile("gemini-3.1-flash-lite")?.thinkingEffortLevels).toEqual([
			"minimal",
			"low",
			"medium",
			"high",
		]);
	});

	it.each(BUDGET_RANGE_CASES)(
		"keeps every $name budget wire value inside its documented range",
		({ id, min, max }) => {
			const thinking = getGeminiGenerateContentProfile(id)?.thinking;
			expect(thinking?.control).toBe("budget");
			if (thinking?.control !== "budget") return;
			const { low, medium, high } = thinking.budgets;
			expect([low, medium, high]).toEqual([low, medium, high].slice().sort((a, b) => a - b));
			expect(low).toBeGreaterThanOrEqual(min);
			expect(high).toBeLessThanOrEqual(max);
		},
	);
});
