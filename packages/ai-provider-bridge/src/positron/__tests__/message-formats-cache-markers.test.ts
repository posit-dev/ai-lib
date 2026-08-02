/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * The vscode.lm path translates only Anthropic cache markers. OpenAI explicit
 * prompt-cache markers (`openai.promptCacheBreakpoint`) must stay inert here:
 * they are never converted into vscode.lm cache-control parts and never
 * corrupt the converted message content.
 */

import type * as ai from "ai";
import { describe, expect, it, vi } from "vitest";

vi.mock("vscode", () => import("./vscode-mock"));

import { isCacheBreakpointPart } from "../lm-helpers";
import { fromAiMessages2 } from "../message-formats";

describe("fromAiMessages2 cache marker translation", () => {
	it("translates Anthropic markers but keeps OpenAI explicit markers inert", () => {
		const messages: ai.ModelMessage[] = [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "anthropic-marked",
						providerOptions: { anthropic: { cacheControl: { type: "ephemeral" } } },
					},
					{
						type: "text",
						text: "openai-marked",
						providerOptions: { openai: { promptCacheBreakpoint: { mode: "explicit" } } },
					},
				],
			},
		];

		const withMarkers = fromAiMessages2(messages, { preserveCacheMarkers: true });
		expect(withMarkers).toHaveLength(1);
		const breakpoints = withMarkers[0].content.filter((part) => isCacheBreakpointPart(part));
		expect(breakpoints).toHaveLength(1);

		// Both text parts survive untouched.
		const texts = withMarkers[0].content
			.filter((part): part is { value: string } => "value" in part && !isCacheBreakpointPart(part))
			.map((part) => part.value);
		expect(texts).toEqual(["anthropic-marked", "openai-marked"]);

		// Without preservation, no cache parts at all.
		const withoutMarkers = fromAiMessages2(messages, { preserveCacheMarkers: false });
		expect(withoutMarkers[0].content.some((part) => isCacheBreakpointPart(part))).toBe(false);
	});
});
