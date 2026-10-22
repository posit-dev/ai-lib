/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mintCustomProviderId } from "ai-config";
import type { ResolvedConnection, ResolvedProvider } from "ai-config";
import { describe, expect, it } from "vitest";

import { servableProviders } from "../mappings";

function entry(
	id: string,
	overrides: Partial<ResolvedProvider> & { connection?: ResolvedConnection } = {},
): ResolvedProvider {
	return {
		id: id as ResolvedProvider["id"],
		clientKind: "openai-compatible",
		enabled: true,
		connection: {},
		connectionProvenance: {},
		models: undefined,
		...overrides,
	};
}

function mappingFor(catalog: readonly ResolvedProvider[], providerId: string) {
	return servableProviders(catalog).find((s) => s.mapping.providerId === providerId)?.mapping;
}

describe("servableProviders", () => {
	it("maps anthropic to its auth provider with a session", () => {
		expect(mappingFor([], "anthropic")).toEqual({
			providerId: "anthropic",
			authProviderId: "anthropic",
			scopes: [],
			requiresSession: true,
		});
	});

	it("has no mapping for copilot", () => {
		expect(mappingFor([], "copilot")).toBeUndefined();
	});

	it.each(["ollama", "lmstudio"])("serves %s without a session or auth", (id) => {
		const servable = servableProviders([]).find((s) => s.mapping.providerId === id);
		expect(servable?.mapping).toEqual({ providerId: id, scopes: [], requiresSession: false });
		expect(servable?.auth).toBeUndefined();
	});

	it("requires a session for Foundry unless the catalog sets Entra mode", () => {
		const foundry = (azure?: { authMode: "entra" | "apikey" }) =>
			mappingFor([entry("ms-foundry", { connection: { azure } })], "ms-foundry");
		expect(foundry()?.requiresSession).toBe(true);
		expect(foundry({ authMode: "apikey" })?.requiresSession).toBe(true);
		expect(foundry({ authMode: "entra" })?.requiresSession).toBe(false);
	});

	it("maps a custom openai-compatible entry to the custom-providers auth provider without requiring a session", () => {
		const id = mintCustomProviderId("my-gateway");
		const servable = servableProviders([entry(id, { clientKind: "openai-compatible" })]).find(
			(s) => s.mapping.providerId === id,
		);
		expect(servable?.mapping).toEqual({
			providerId: id,
			authProviderId: "custom-providers",
			scopes: [id],
			requiresSession: false,
		});
		expect(servable?.clientKind).toBe("openai-compatible");
		expect(servable?.apiKeyOptional).toBe(true);
	});

	it.each(["litellm", "openai-compatible"])(
		"serves built-in %s without requiring a session",
		(id) => {
			const servable = servableProviders([]).find((s) => s.mapping.providerId === id);
			expect(servable?.mapping.requiresSession).toBe(false);
			expect(servable?.mapping.authProviderId).toBe(id);
			expect(servable?.apiKeyOptional).toBe(true);
		},
	);

	it("requires a session for built-in Portkey, which has no keyless mode", () => {
		const servable = servableProviders([]).find((s) => s.mapping.providerId === "portkey");
		expect(servable?.mapping.requiresSession).toBe(true);
		expect(servable?.apiKeyOptional).toBeUndefined();
	});

	it("requires a session for a custom anthropic entry", () => {
		const id = mintCustomProviderId("my-anthropic");
		expect(mappingFor([entry(id, { clientKind: "anthropic" })], id)?.requiresSession).toBe(true);
	});

	it("follows a custom entry's resolved auth policy over the kind default", () => {
		const id = mintCustomProviderId("my-anthropic");
		const authPolicy = { apiKeyOptional: true, source: "user" } as const;
		const servable = servableProviders([entry(id, { clientKind: "anthropic", authPolicy })]).find(
			(s) => s.mapping.providerId === id,
		);
		expect(servable?.mapping.requiresSession).toBe(false);
		expect(servable?.apiKeyOptional).toBe(true);
	});

	it("serves a custom ollama entry without a session", () => {
		const id = mintCustomProviderId("my-ollama");
		const servable = servableProviders([entry(id, { clientKind: "ollama" })]).find(
			(s) => s.mapping.providerId === id,
		);
		expect(servable?.mapping).toEqual({ providerId: id, scopes: [], requiresSession: false });
		expect(servable?.auth).toBeUndefined();
		expect(servable?.clientKind).toBe("ollama");
	});

	it("leaves out a custom entry with an unsupported kind", () => {
		const id = mintCustomProviderId("my-positai");
		expect(mappingFor([entry(id, { clientKind: "positai" })], id)).toBeUndefined();
	});
});
