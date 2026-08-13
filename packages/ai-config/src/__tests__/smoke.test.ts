/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from "vitest";

import { mintCustomProviderId } from "../index.js";

describe("mintCustomProviderId", () => {
	it("mints a valid custom provider id", () => {
		const id = mintCustomProviderId("my-provider");
		expect(id).toBe("my-provider");
	});

	it("rejects empty string", () => {
		expect(() => mintCustomProviderId("")).toThrow("non-empty");
	});

	it("rejects built-in provider id", () => {
		expect(() => mintCustomProviderId("anthropic")).toThrow("collides with a built-in");
	});

	it("rejects reserved key 'default'", () => {
		expect(() => mintCustomProviderId("default")).toThrow("reserved key");
	});

	it("rejects reserved key 'custom'", () => {
		expect(() => mintCustomProviderId("custom")).toThrow("reserved key");
	});

	it("rejects unsafe key '__proto__'", () => {
		expect(() => mintCustomProviderId("__proto__")).toThrow("unsafe");
	});
});
