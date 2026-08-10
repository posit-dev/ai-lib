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

describe("stripCatalogSlug", () => {
	it("strips the @slug/ prefix up to the first slash", () => {
		expect(stripCatalogSlug("@anthropic-prod/claude-haiku-4-5")).toBe("claude-haiku-4-5");
		expect(stripCatalogSlug("@prod/nested/model")).toBe("nested/model");
	});

	it("returns ids without the @slug/ shape unchanged", () => {
		expect(stripCatalogSlug("claude-haiku-4-5")).toBe("claude-haiku-4-5");
		expect(stripCatalogSlug("@no-slash")).toBe("@no-slash");
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
	it("gives Claude ids Anthropic capabilities, stripping catalog slugs internally", () => {
		const routed = getPortkeyModelCapabilities("@anthropic-prod/claude-haiku-4-5");
		expect(routed).toBeDefined();
		expect(routed?.maxOutputTokens).toBe(64_000);
		expect(getPortkeyModelCapabilities("claude-haiku-4-5")).toBeDefined();
	});

	it("returns undefined for non-Claude ids (conservative defaults apply)", () => {
		// TODO(phase0-gate): widen per probe matrix — no OpenAI-caps branch yet.
		expect(getPortkeyModelCapabilities("gpt-5-mini")).toBeUndefined();
		expect(getPortkeyModelCapabilities("@prod/qwen-3-coder")).toBeUndefined();
	});
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
