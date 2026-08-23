/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { inferModelCapabilities } from "../infer.js";
import {
	classifyPortkeyModel,
	getPortkeyModelCapabilities,
	stripCatalogSlug,
} from "../portkey-helpers.js";

type CatalogSlugNormalizationCase = {
	name: string;
	id: string;
	expected: string;
};

const CATALOG_SLUG_NORMALIZATION_CASES = [
	{
		name: "catalog model id",
		id: "@anthropic-prod/claude-haiku-4-5",
		expected: "claude-haiku-4-5",
	},
	{ name: "nested model id", id: "@prod/nested/model", expected: "nested/model" },
] satisfies readonly CatalogSlugNormalizationCase[];

const CLAUDE_CAPABILITY_CASES = [
	{ name: "catalog-routed Claude id", id: "@anthropic-prod/claude-haiku-4-5" },
	{ name: "bare Claude id", id: "claude-haiku-4-5" },
] satisfies readonly { name: string; id: string }[];

const CONSERVATIVE_CAPABILITY_CASES = [
	{ name: "OpenAI id", id: "gpt-5-mini" },
	{ name: "unrecognized catalog id", id: "@prod/qwen-3-coder" },
] satisfies readonly { name: string; id: string }[];

describe("stripCatalogSlug", () => {
	it.each(CATALOG_SLUG_NORMALIZATION_CASES)(
		"strips the @slug/ prefix from a $name",
		({ id, expected }) => {
			expect(stripCatalogSlug(id)).toBe(expected);
		},
	);

	it("returns a bare id unchanged", () => {
		expect(stripCatalogSlug("claude-haiku-4-5")).toBe("claude-haiku-4-5");
	});

	it("returns a malformed @slug signature without a slash unchanged", () => {
		expect(stripCatalogSlug("@no-slash")).toBe("@no-slash");
	});

	it("returns an empty id unchanged", () => {
		expect(stripCatalogSlug("")).toBe("");
	});
});

describe("classifyPortkeyModel", () => {
	it("classifies Claude from the stripped routed id and routes it over anthropic-messages", () => {
		const decision = classifyPortkeyModel({ id: "@anthropic-prod/claude-haiku-4-5" });
		expect(decision.family).toBe("claude");
		expect(decision.capabilityModelId).toBe("claude-haiku-4-5");
		expect(decision.supported).toBe(true);
		if (decision.supported) {
			expect(decision.protocol).toBe("anthropic-messages");
		}
	});

	it("trusts canonical_slug over an opaque routed alias", () => {
		const decision = classifyPortkeyModel({
			id: "@prod/approved-assistant",
			canonicalSlug: "claude-sonnet-5-20251101",
		});
		expect(decision.family).toBe("claude");
		expect(decision.capabilityModelId).toBe("claude-sonnet-5-20251101");
		expect(decision.supported).toBe(true);
	});

	it("never classifies by the slug: a Claude-looking slug with an opaque alias is not Claude", () => {
		const decision = classifyPortkeyModel({ id: "@claude-prod/approved-assistant" });
		expect(decision.family).toBe("other");
		expect(decision.supported).toBe(false);
	});

	// TODO(phase0-gate): these exclusions widen per the probe matrix.
	it("classifies but excludes OpenAI-family entries pending the Phase 0 probe", () => {
		const decision = classifyPortkeyModel({ id: "@openai-prod/gpt-5-mini", provider: "openai" });
		expect(decision.family).toBe("openai");
		expect(decision.supported).toBe(false);
		if (!decision.supported) {
			expect(decision.exclusionReason).toMatch(/Phase 0 probe/);
		}
	});

	it("classifies but excludes Gemini-family entries pending the Phase 0 probe", () => {
		const decision = classifyPortkeyModel({
			id: "@google-prod/gemini-2.5-flash",
			provider: "google",
		});
		expect(decision.family).toBe("gemini");
		expect(decision.supported).toBe(false);
	});

	it("lets a non-OpenAI provider signal veto an OpenAI-looking id", () => {
		// A deceptive alias: OpenAI-shaped id fronting a Gemini upstream.
		const decision = classifyPortkeyModel({ id: "@gw/gpt-5-mini", provider: "gemini" });
		expect(decision.family).toBe("gemini");
		expect(decision.supported).toBe(false);
	});

	it("excludes unrecognized families with a reason", () => {
		const decision = classifyPortkeyModel({ id: "@prod/qwen-3-coder" });
		expect(decision.family).toBe("other");
		expect(decision.supported).toBe(false);
		if (!decision.supported) {
			expect(decision.exclusionReason).toBeTruthy();
		}
	});
});

describe("getPortkeyModelCapabilities", () => {
	it.each(CLAUDE_CAPABILITY_CASES)("gives a $name Anthropic capabilities", ({ id }) => {
		const caps = getPortkeyModelCapabilities(id);
		expect(caps).toBeDefined();
		expect(caps?.maxOutputTokens).toBe(64_000);
	});

	// TODO(phase0-gate): widen per probe matrix — no OpenAI-caps branch yet.
	it.each(CONSERVATIVE_CAPABILITY_CASES)(
		"returns undefined for an $name so conservative defaults apply",
		({ id }) => {
			expect(getPortkeyModelCapabilities(id)).toBeUndefined();
		},
	);
});

// The ID-only seam has no catalog metadata; the catalog-entry classifier tests
// above do not exercise it. Provisional Claude-or-conservative rule
// (TODO(phase1) in portkey-helpers.ts) pinned directly here.
describe('inferModelCapabilities("portkey", id) — ID-only rule', () => {
	it("gives a Claude-shaped id Anthropic capabilities after slug stripping", () => {
		const caps = inferModelCapabilities("portkey", "@anthropic-prod/claude-sonnet-5-20251101");
		expect(caps.thinkingEffortLevels).toBeDefined();
		expect(caps.supportsImages).toBe(true);
	});

	it("keeps a gpt-5-shaped id conservative (no OpenAI capability table)", () => {
		const caps = inferModelCapabilities("portkey", "gpt-5-mini");
		expect(caps.thinkingEffortLevels).toBeUndefined();
		expect(caps.maxContextLength).toBe(128_000);
	});

	it("keeps an unrecognized id conservative", () => {
		const caps = inferModelCapabilities("portkey", "approved-assistant");
		expect(caps.thinkingEffortLevels).toBeUndefined();
		expect(caps.maxContextLength).toBe(128_000);
		expect(caps.supportsImages).toBe(false);
	});
});
