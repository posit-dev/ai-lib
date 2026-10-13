/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { checkPortkeyConnection, inferredPortkeyKeyType } from "../portkey-connection.js";
import type { ProviderConfigSource } from "../resolve-catalog.js";
import { resolveProviderCatalog, resolveProviderCatalogReport } from "../resolve-catalog.js";
import { providersConfigSchema } from "../schema.js";
import type { ResolvedProvider } from "../types.js";

const HOSTED = "https://api.portkey.ai/v1";
const PROXY = "https://proxy.example.com/portkey";

function portkey(catalog: readonly ResolvedProvider[]): ResolvedProvider {
	const entry = catalog.find((p) => p.id === "portkey");
	if (!entry) throw new Error("portkey missing from catalog");
	return entry;
}

function source(
	kind: ProviderConfigSource["kind"],
	config: ProviderConfigSource["config"],
): ProviderConfigSource {
	return { kind, config };
}

describe("checkPortkeyConnection", () => {
	it("accepts a saved key reported only by presence", () => {
		expect(
			checkPortkeyConnection({ baseUrl: PROXY, keyType: "portkey", apiKeyPresent: true }),
		).toEqual({ ok: true, baseUrl: PROXY, keyType: "portkey", canonical: false });
	});

	it("infers the key type from the URL when none is configured", () => {
		expect(
			checkPortkeyConnection({ baseUrl: HOSTED, keyType: undefined, apiKeyPresent: true }),
		).toMatchObject({ ok: true, keyType: "portkey", canonical: true });
		expect(
			checkPortkeyConnection({ baseUrl: PROXY, keyType: undefined, apiKeyPresent: false }),
		).toMatchObject({ ok: true, keyType: "upstream", canonical: false });
	});

	it("requires a base URL", () => {
		expect(
			checkPortkeyConnection({ baseUrl: "  ", keyType: "portkey", apiKeyPresent: true }),
		).toMatchObject({ ok: false, field: "baseUrl" });
	});

	it("rejects an unparseable URL", () => {
		expect(
			checkPortkeyConnection({ baseUrl: "not a url", keyType: undefined, apiKeyPresent: true }),
		).toMatchObject({ ok: false, field: "baseUrl" });
	});

	it("rejects the hosted hostname on a non-canonical origin", () => {
		expect(
			checkPortkeyConnection({
				baseUrl: "http://api.portkey.ai/v1",
				keyType: "portkey",
				apiKeyPresent: true,
			}),
		).toMatchObject({ ok: false, field: "baseUrl" });
	});

	it("rejects an upstream key on the hosted origin", () => {
		expect(
			checkPortkeyConnection({ baseUrl: HOSTED, keyType: "upstream", apiKeyPresent: true }),
		).toMatchObject({ ok: false, field: "keyType" });
	});

	it("requires a Portkey key, configured or inferred", () => {
		expect(
			checkPortkeyConnection({ baseUrl: PROXY, keyType: "portkey", apiKeyPresent: false }),
		).toMatchObject({ ok: false, field: "apiKey" });
		expect(
			checkPortkeyConnection({ baseUrl: HOSTED, keyType: undefined, apiKeyPresent: false }),
		).toMatchObject({ ok: false, field: "apiKey" });
	});

	it("allows plain HTTP for a Portkey-key gateway", () => {
		expect(
			checkPortkeyConnection({
				baseUrl: "http://gateway.portkey.svc.cluster.local:8787/v1",
				keyType: "portkey",
				apiKeyPresent: true,
			}),
		).toMatchObject({ ok: true });
	});
});

describe("inferredPortkeyKeyType", () => {
	it("is portkey only for the canonical hosted origin", () => {
		expect(inferredPortkeyKeyType(HOSTED)).toBe("portkey");
		expect(inferredPortkeyKeyType(PROXY)).toBe("upstream");
		expect(inferredPortkeyKeyType("not a url")).toBe("upstream");
	});
});

describe("Portkey keyType in providers.json", () => {
	it("accepts keyType only on the built-in portkey block", () => {
		expect(
			providersConfigSchema.safeParse({
				providers: { portkey: { baseUrl: PROXY, keyType: "portkey" } },
			}).success,
		).toBe(true);
		expect(
			providersConfigSchema.safeParse({ providers: { portkey: { keyType: "hosted" } } }).success,
		).toBe(false);
		expect(
			providersConfigSchema.safeParse({ providers: { litellm: { keyType: "portkey" } } }).success,
		).toBe(false);
	});

	it("keeps a bad combination valid so it never blocks saves", () => {
		expect(
			providersConfigSchema.safeParse({
				providers: { portkey: { baseUrl: HOSTED, keyType: "upstream" } },
			}).success,
		).toBe(true);
	});

	it("resolves keyType onto the connection with per-field provenance", () => {
		const entry = portkey(
			resolveProviderCatalog({
				sources: [
					source("user", { providers: { portkey: { baseUrl: PROXY, keyType: "portkey" } } }),
				],
				envVars: {},
			}),
		);
		expect(entry.connection).toMatchObject({ baseUrl: PROXY, keyType: "portkey" });
		expect(entry.connectionProvenance.portkey).toEqual({ keyType: "user", baseUrl: "user" });
	});

	it("reports unset fields as absent provenance", () => {
		const entry = portkey(resolveProviderCatalog({ sources: [], envVars: {} }));
		expect(entry.connection.keyType).toBeUndefined();
		expect(entry.connectionProvenance.portkey).toEqual({ keyType: undefined, baseUrl: undefined });
	});

	it("lets PORTKEY_KEY_TYPE outrank the user layer, and enforced outrank env", () => {
		const user = source("user", {
			providers: { portkey: { baseUrl: PROXY, keyType: "upstream" } },
		});

		const envOverUser = portkey(
			resolveProviderCatalog({ sources: [user], envVars: { PORTKEY_KEY_TYPE: "portkey" } }),
		);
		expect(envOverUser.connection.keyType).toBe("portkey");
		expect(envOverUser.connectionProvenance.portkey?.keyType).toBe("environment");

		const enforcedOverEnv = portkey(
			resolveProviderCatalog({
				sources: [source("enforced", { providers: { portkey: { keyType: "upstream" } } }), user],
				envVars: { PORTKEY_KEY_TYPE: "portkey" },
			}),
		);
		expect(enforcedOverEnv.connection.keyType).toBe("upstream");
		expect(enforcedOverEnv.connectionProvenance.portkey?.keyType).toBe("enforced");
	});

	it("reports the key type below the user layer even when a user value hides it", () => {
		const entry = portkey(
			resolveProviderCatalog({
				sources: [
					source("user", { providers: { portkey: { baseUrl: HOSTED, keyType: "portkey" } } }),
					source("default", { providers: { portkey: { keyType: "upstream" } } }),
				],
				envVars: {},
			}),
		);
		expect(entry.connection.keyType).toBe("portkey");
		expect(entry.connectionProvenance.portkey).toEqual({
			keyType: "user",
			baseUrl: "user",
			keyTypeAfterUserClear: "upstream",
		});
	});

	it("drops every env connection setting, and reports it, when PORTKEY_KEY_TYPE is invalid", () => {
		const report = resolveProviderCatalogReport({
			sources: [],
			envVars: { PORTKEY_KEY_TYPE: "hosted", PORTKEY_BASE_URL: PROXY },
		});

		const entry = portkey(report.catalog);
		expect(entry.connection.keyType).toBeUndefined();
		expect(entry.connection.baseUrl).toBeUndefined();
		expect(report.issues).toEqual([
			expect.objectContaining({
				severity: "error",
				source: expect.objectContaining({ kind: "env" }),
				message: expect.stringContaining("providers.portkey.keyType"),
			}),
		]);
	});
});
