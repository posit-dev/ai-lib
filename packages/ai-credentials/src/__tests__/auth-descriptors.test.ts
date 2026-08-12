/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import {
	CUSTOM_CLIENT_KIND_AUTH_MAP,
	SUPPORTED_CUSTOM_CLIENT_KIND_VALUES,
} from "../types/index.js";

describe("custom-provider auth descriptors", () => {
	it.each(["anthropic", "openai", "gemini"])(
		"requires an API key for custom %s providers",
		(kind) => {
			expect(SUPPORTED_CUSTOM_CLIENT_KIND_VALUES).toContain(kind);
			expect(CUSTOM_CLIENT_KIND_AUTH_MAP.get(kind)).toEqual({
				authMethodId: "apikey",
				apiKeyOptional: false,
			});
		},
	);

	it.each(["positai", "copilot", "databricks"])("keeps %s product-bound", (kind) => {
		expect(SUPPORTED_CUSTOM_CLIENT_KIND_VALUES).not.toContain(kind);
		expect(CUSTOM_CLIENT_KIND_AUTH_MAP.has(kind)).toBe(false);
	});
});
