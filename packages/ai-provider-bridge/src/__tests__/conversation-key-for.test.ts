/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { conversationKeyFor } from "../model-clients/CopilotSdkClient";

describe("conversationKeyFor", () => {
	it("returns sessionId when provided", () => {
		expect(conversationKeyFor({ metadata: { sessionId: "conv-123" } })).toBe("conv-123");
	});

	it("returns default key when metadata is undefined", () => {
		expect(conversationKeyFor({})).toBe("__default__");
	});

	it("returns default key when sessionId is undefined", () => {
		expect(conversationKeyFor({ metadata: {} })).toBe("__default__");
	});

	it("returns default key when metadata.sessionId is undefined", () => {
		expect(conversationKeyFor({ metadata: { sessionId: undefined } })).toBe("__default__");
	});
});
