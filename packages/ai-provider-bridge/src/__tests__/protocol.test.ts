/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { normalizeProtocol } from "../types";

describe("normalizeProtocol", () => {
	it('maps legacy "anthropic" to "anthropic-messages"', () => {
		expect(normalizeProtocol("anthropic")).toBe("anthropic-messages");
	});

	it('maps legacy "openai" to "openai-chat"', () => {
		expect(normalizeProtocol("openai")).toBe("openai-chat");
	});

	it("passes through canonical protocol values unchanged", () => {
		expect(normalizeProtocol("anthropic-messages")).toBe("anthropic-messages");
		expect(normalizeProtocol("openai-chat")).toBe("openai-chat");
		expect(normalizeProtocol("openai-responses")).toBe("openai-responses");
		expect(normalizeProtocol("bedrock-converse")).toBe("bedrock-converse");
		expect(normalizeProtocol("google-generative")).toBe("google-generative");
	});

	it("returns undefined for undefined", () => {
		expect(normalizeProtocol(undefined)).toBeUndefined();
	});
});
