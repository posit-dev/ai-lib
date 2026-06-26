/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from "vitest";

import { mintCustomProviderId } from "../types";

describe("ai-config", () => {
	it("pure entry module loads", async () => {
		const mod = await import("../index");
		expect(mod).toBeDefined();
	});

	it("node entry module loads", async () => {
		const mod = await import("../node/index");
		expect(mod).toBeDefined();
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
});
