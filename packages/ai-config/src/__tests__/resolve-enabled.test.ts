/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from "vitest";

import type { EnablementLayer } from "../resolve-enabled";
import { resolveEnabled } from "../resolve-enabled";
import type { PlatformBaseline, ProvidersMap } from "../types";

const standaloneBaseline: PlatformBaseline = { defaultEnabled: true };
const rstudioBaseline: PlatformBaseline = {
	defaultEnabled: false,
	providerOverrides: { positai: { enabled: true } },
};

/** Build a highest-first layer stack, dropping undefined layers. */
function layers(...ls: EnablementLayer[]): EnablementLayer[] {
	return ls;
}

describe("resolveEnabled", () => {
	it("uses platform baseline when no layers exist", () => {
		expect(resolveEnabled("anthropic", [], standaloneBaseline)).toBe(true);
		expect(resolveEnabled("anthropic", [], rstudioBaseline)).toBe(false);
		expect(resolveEnabled("positai", [], rstudioBaseline)).toBe(true);
	});

	it("user default.enabled overrides platform baseline", () => {
		const user: ProvidersMap = { default: { enabled: false } };
		expect(resolveEnabled("anthropic", layers(user), standaloneBaseline)).toBe(false);
	});

	it("user per-provider enabled overrides user default", () => {
		const user: ProvidersMap = {
			default: { enabled: false },
			anthropic: { enabled: true },
		};
		expect(resolveEnabled("anthropic", layers(user), standaloneBaseline)).toBe(true);
		// Other providers still get the default
		expect(resolveEnabled("openai", layers(user), standaloneBaseline)).toBe(false);
	});

	it("enforced default.enabled overrides user per-provider", () => {
		const user: ProvidersMap = { anthropic: { enabled: true } };
		const enforced: ProvidersMap = { default: { enabled: false } };
		// Highest-first: [enforced, user]
		expect(resolveEnabled("anthropic", layers(enforced, user), standaloneBaseline)).toBe(false);
	});

	it("enforced per-provider overrides everything", () => {
		const user: ProvidersMap = { anthropic: { enabled: true } };
		const enforced: ProvidersMap = { anthropic: { enabled: false } };
		expect(resolveEnabled("anthropic", layers(enforced, user), standaloneBaseline)).toBe(false);
	});

	it("enforced per-provider wins over enforced default", () => {
		const enforced: ProvidersMap = {
			default: { enabled: false },
			anthropic: { enabled: true },
		};
		expect(resolveEnabled("anthropic", layers(enforced), standaloneBaseline)).toBe(true);
		expect(resolveEnabled("openai", layers(enforced), standaloneBaseline)).toBe(false);
	});

	it("host layer sits below user, above default", () => {
		// user disables a provider; host would enable it → user wins.
		const user: ProvidersMap = { anthropic: { enabled: false } };
		const host: ProvidersMap = { anthropic: { enabled: true } };
		expect(resolveEnabled("anthropic", layers(user, host), standaloneBaseline)).toBe(false);

		// default enables; host disables → host (higher) wins.
		const hostOff: ProvidersMap = { openai: { enabled: false } };
		const defaults: ProvidersMap = { openai: { enabled: true } };
		expect(resolveEnabled("openai", layers(hostOff, defaults), standaloneBaseline)).toBe(false);
	});

	it("resolves custom provider ids from providers.custom", () => {
		const user: ProvidersMap = {
			custom: { myprovider: { type: "openai-compatible", enabled: true } },
		};
		expect(resolveEnabled("myprovider", layers(user), { defaultEnabled: false })).toBe(true);
	});

	it("platform baseline per-provider override applies", () => {
		// RStudio baseline: positai enabled, everything else disabled
		expect(resolveEnabled("positai", [], rstudioBaseline)).toBe(true);
		expect(resolveEnabled("anthropic", [], rstudioBaseline)).toBe(false);
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
		expect(resolveEnabled("anthropic", layers(enforced, user), rstudioBaseline)).toBe(true);
		// Enforced default=false applies to openai (no per-provider enforced)
		expect(resolveEnabled("openai", layers(enforced, user), rstudioBaseline)).toBe(false);
	});
});
