/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { CUSTOM_CLIENT_KIND_AUTH_MAP, resolveCustomAuthMapping } from "../auth-descriptors.js";

describe("resolveCustomAuthMapping", () => {
	it("returns the kind-level mapping when the entry authors nothing", () => {
		expect(resolveCustomAuthMapping("anthropic")).toEqual({
			authMethodId: "apikey",
			apiKeyOptional: false,
		});
		expect(resolveCustomAuthMapping("anthropic", {})).toEqual({
			authMethodId: "apikey",
			apiKeyOptional: false,
		});
	});

	it("an authored true relaxes a key-required kind", () => {
		expect(resolveCustomAuthMapping("anthropic", { apiKeyOptional: true })).toEqual({
			authMethodId: "apikey",
			apiKeyOptional: true,
		});
	});

	it("an authored false cannot tighten a key-optional kind", () => {
		expect(resolveCustomAuthMapping("openai-compatible", { apiKeyOptional: false })).toEqual({
			authMethodId: "apikey",
			apiKeyOptional: true,
		});
	});

	it("returns undefined for kinds with no descriptor", () => {
		expect(resolveCustomAuthMapping("positai")).toBeUndefined();
		expect(resolveCustomAuthMapping("positai", { apiKeyOptional: true })).toBeUndefined();
	});

	it("returns the shared kind mapping object when no entry value applies", () => {
		// Back-compat: consumers comparing by reference against
		// CUSTOM_CLIENT_KIND_AUTH_MAP keep working when nothing is authored.
		expect(resolveCustomAuthMapping("anthropic")).toBe(
			CUSTOM_CLIENT_KIND_AUTH_MAP.get("anthropic"),
		);
	});
});
