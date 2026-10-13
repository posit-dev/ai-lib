/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type * as ai from "ai";
import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import type { AiToolWithJsonSchema } from "../../types";
import { mergeOpenAIWebSearchTool, mergeProviderTools } from "../provider-tools";

function localTool(): AiToolWithJsonSchema {
	return { inputSchema: jsonSchema({ type: "object", properties: {} }) };
}

function providerTool(): ai.Tool {
	return { inputSchema: jsonSchema({ type: "object", properties: {} }) };
}

describe("mergeProviderTools", () => {
	it("rejects when a local tool occupies the provider tool's key", () => {
		expect(() =>
			mergeProviderTools({ web_search: localTool() }, { web_search: providerTool() }),
		).toThrowError(/local tool named "web_search"/);
	});

	it("rejects when a local tool occupies the google_search key", () => {
		expect(() =>
			mergeProviderTools({ google_search: localTool() }, { google_search: providerTool() }),
		).toThrowError(/local tool named "google_search"/);
	});

	it("leaves a like-named local tool untouched when no provider tool needs its key", () => {
		const local = localTool();
		const merged = mergeProviderTools({ web_search: local }, { google_search: providerTool() });
		expect(merged.web_search).toBe(local);
		expect(merged.google_search).toBeDefined();
	});

	it("returns local tools unchanged when attaching nothing", () => {
		const local = localTool();
		expect(mergeProviderTools({ readFile: local }, {})).toEqual({ readFile: local });
	});

	it("attaches provider tools when no local toolset exists", () => {
		const provider = providerTool();
		expect(mergeProviderTools(undefined, { web_search: provider })).toEqual({
			web_search: provider,
		});
	});
});

describe("mergeOpenAIWebSearchTool", () => {
	it("returns the local toolset unchanged when disabled", () => {
		const local = localTool();
		expect(mergeOpenAIWebSearchTool({ readFile: local }, false)).toEqual({ readFile: local });
	});

	it("returns undefined when disabled with no local tools, so toolChoice stays unset", () => {
		expect(mergeOpenAIWebSearchTool(undefined, false)).toBeUndefined();
	});

	it("attaches the OpenAI Responses web_search provider tool when enabled", () => {
		const merged = mergeOpenAIWebSearchTool(undefined, true);
		expect(merged?.web_search).toMatchObject({
			type: "provider",
			id: "openai.web_search",
			args: {},
		});
	});

	it("serializes an explicit external-access policy into the tool args", () => {
		const merged = mergeOpenAIWebSearchTool(undefined, true, { externalWebAccess: false });
		expect(merged?.web_search).toMatchObject({
			type: "provider",
			id: "openai.web_search",
			args: { externalWebAccess: false },
		});
	});

	it("rejects a local tool occupying the web_search key", () => {
		expect(() => mergeOpenAIWebSearchTool({ web_search: localTool() }, true)).toThrowError(
			/local tool named "web_search"/,
		);
	});
});
