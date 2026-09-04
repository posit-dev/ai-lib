/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type * as ai from "ai";
import { jsonSchema } from "ai";
import { describe, expect, it } from "vitest";

import type { AiToolWithJsonSchema } from "../../types";
import { mergeProviderTools } from "../provider-tools";

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
