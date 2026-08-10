/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from "vitest";

import { customProviderEntrySchema, mintCustomProviderId } from "../index.js";

describe("ai-config", () => {
	it("pure entry module loads", async () => {
		const mod = await import("../index.js");
		expect(mod).toBeDefined();
	});

	it("node entry module loads", async () => {
		const mod = await import("../node/index.js");
		expect(mod).toBeDefined();
	});

	it("exports the pure custom-provider entry schema", () => {
		expect(
			customProviderEntrySchema.safeParse({
				type: "openai-compatible",
				baseUrl: "https://gateway.example/v1",
			}).success,
		).toBe(true);
	});
});

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
