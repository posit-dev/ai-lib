/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from "vitest";

import { resolveEnabled } from "../resolve-enabled";
import type { PlatformBaseline, ProvidersMap } from "../types";

const standaloneBaseline: PlatformBaseline = { defaultEnabled: true };
const rstudioBaseline: PlatformBaseline = {
	defaultEnabled: false,
	providerOverrides: { positai: { enabled: true } },
};

describe("resolveEnabled", () => {
	it("uses platform baseline when no config exists", () => {
		expect(resolveEnabled("anthropic", undefined, undefined, standaloneBaseline)).toBe(true);
		expect(resolveEnabled("anthropic", undefined, undefined, rstudioBaseline)).toBe(false);
		expect(resolveEnabled("positai", undefined, undefined, rstudioBaseline)).toBe(true);
	});

	it("user default.enabled overrides platform baseline", () => {
		const user: ProvidersMap = { default: { enabled: false } };
		expect(resolveEnabled("anthropic", user, undefined, standaloneBaseline)).toBe(false);
	});

	it("user per-provider enabled overrides user default", () => {
		const user: ProvidersMap = {
			default: { enabled: false },
			anthropic: { enabled: true },
		};
		expect(resolveEnabled("anthropic", user, undefined, standaloneBaseline)).toBe(true);
		// Other providers still get the default
		expect(resolveEnabled("openai", user, undefined, standaloneBaseline)).toBe(false);
	});

	it("enforced default.enabled overrides user per-provider", () => {
		const user: ProvidersMap = { anthropic: { enabled: true } };
		const enforced: ProvidersMap = { default: { enabled: false } };
		expect(resolveEnabled("anthropic", user, enforced, standaloneBaseline)).toBe(false);
	});

	it("enforced per-provider overrides everything", () => {
		const user: ProvidersMap = { anthropic: { enabled: true } };
		const enforced: ProvidersMap = { anthropic: { enabled: false } };
		expect(resolveEnabled("anthropic", user, enforced, standaloneBaseline)).toBe(false);
	});

	it("enforced per-provider wins over enforced default", () => {
		const enforced: ProvidersMap = {
			default: { enabled: false },
			anthropic: { enabled: true },
		};
		expect(resolveEnabled("anthropic", undefined, enforced, standaloneBaseline)).toBe(true);
		expect(resolveEnabled("openai", undefined, enforced, standaloneBaseline)).toBe(false);
	});

	it("resolves custom provider ids from providers.custom", () => {
		const user: ProvidersMap = {
			custom: { myprovider: { type: "openai-compatible", enabled: true } },
		};
		expect(resolveEnabled("myprovider", user, undefined, { defaultEnabled: false })).toBe(true);
	});

	it("platform baseline per-provider override applies", () => {
		// RStudio baseline: positai enabled, everything else disabled
		expect(resolveEnabled("positai", undefined, undefined, rstudioBaseline)).toBe(true);
		expect(resolveEnabled("anthropic", undefined, undefined, rstudioBaseline)).toBe(false);
	});

	it("full precedence ladder works correctly", () => {
		const user: ProvidersMap = {
			default: { enabled: true },
			anthropic: { enabled: true },
		};
		const enforced: ProvidersMap = {
			default: { enabled: false },
			anthropic: { enabled: true },
		};
		// Enforced anthropic=true wins
		expect(resolveEnabled("anthropic", user, enforced, rstudioBaseline)).toBe(true);
		// Enforced default=false applies to openai (no per-provider enforced)
		expect(resolveEnabled("openai", user, enforced, rstudioBaseline)).toBe(false);
	});
});
