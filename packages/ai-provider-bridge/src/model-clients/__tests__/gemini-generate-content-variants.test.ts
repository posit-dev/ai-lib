/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Stamp/wire agreement for the Gemini generateContent route, against the real
 * ai-config variant profiles (not stubs).
 *
 * The invariant that matters across the layer split: every effort level
 * ai-config *advertises* for a variant must be expressible on the wire by the
 * client's mapping — no clamping, no silently dropped `thinkingConfig`. If the
 * two ever disagree, a user-selectable effort level would quietly become a
 * different one.
 *
 * The mapping mechanism itself (clamping, off-ability, defaults) is covered in
 * `gemini-generate-content-wire.test.ts` with stubbed profiles.
 */

import { getGeminiGenerateContentProfile } from "ai-config";
import { describe, expect, it } from "vitest";

import { buildGenerateContentOptions } from "../GeminiGenerateContentClient";

/** One representative endpoint name per documented variant tier. */
const VARIANT_MODELS = [
	"gemini-2.5-pro",
	"gemini-2.5-flash",
	"gemini-2.5-flash-lite",
	"gemini-3-pro-preview",
	"gemini-3-flash-preview",
] as const;

describe.each(VARIANT_MODELS)("%s generateContent thinking", (model) => {
	const profile = getGeminiGenerateContentProfile(model);
	if (!profile) throw new Error(`expected an ai-config profile for ${model}`);

	it("expresses every advertised effort level on the wire without clamping", () => {
		for (const effort of profile.thinkingEffortLevels) {
			const { google } = buildGenerateContentOptions({ thinkingEffort: effort, profile });
			const config = google.thinkingConfig;

			if (effort === "off") {
				expect(config).toEqual({ thinkingBudget: 0 });
				continue;
			}
			if (profile.thinking.control === "budget") {
				expect(config?.thinkingBudget).toBe(
					profile.thinking.budgets[effort as "low" | "medium" | "high"],
				);
			} else {
				expect(config?.thinkingLevel).toBe(effort);
			}
			expect(config?.includeThoughts).toBe(true);
		}
	});

	it("advertises 'off' exactly when the wire can represent it", () => {
		const advertisesOff = profile.thinkingEffortLevels.includes("off");
		const representable =
			profile.thinking.control === "budget" && profile.thinking.canDisable === true;
		expect(advertisesOff).toBe(representable);

		if (!representable) {
			// Not advertised, and defensively not silently downgraded either.
			expect(
				buildGenerateContentOptions({ thinkingEffort: "off", profile }).google.thinkingConfig,
			).toBeUndefined();
		}
	});
});
