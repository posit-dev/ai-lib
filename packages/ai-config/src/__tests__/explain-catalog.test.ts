/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import type { ConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import type { ConfigValueTrace, ProviderCatalogExplanation } from "../config-trace.js";
import { explainProviderCatalog, loadProviderCatalogReport } from "../node/load-catalog.js";
import type { LoadCatalogOptions } from "../node/types.js";
import { maskProvidersConfigValue, stripUrlSecrets } from "../providers-config-safe-fields.js";

const ENFORCED = "TEST_EXPLAIN_ENFORCED";
const DEFAULT = "TEST_EXPLAIN_DEFAULT";

function traceAt(
	explanation: ProviderCatalogExplanation,
	path: readonly string[],
): ConfigValueTrace | undefined {
	return explanation.entries.find((entry) => entry.path.join(".") === path.join("."));
}

function leafAt(value: unknown, path: readonly string[]): unknown {
	let node = value;
	for (const key of path) {
		if (typeof node !== "object" || node === null || !Object.hasOwn(node, key)) return undefined;
		node = Object.entries(node).find(([k]) => k === key)?.[1];
	}
	return node;
}

describe("explainProviderCatalog", () => {
	let fixture: ConfigFileFixture;

	beforeEach(async () => {
		fixture = await createConfigFileFixture();
	});

	afterEach(async () => {
		await fixture.cleanup();
	});

	function options(
		envVars: Record<string, string | undefined> = {},
		extra: Omit<LoadCatalogOptions, "configPath" | "envVars" | "logger"> = {},
	) {
		return {
			configPath: fixture.configPath,
			enforcedEnvVar: ENFORCED,
			defaultEnvVar: DEFAULT,
			envVars,
			...extra,
		};
	}

	it.each([
		["missing", undefined, "missing"],
		["empty", "{}", "empty"],
		["invalid", "{ not json", "invalid"],
		["found", '{ "providers": { "openai": { "enabled": false } } }', "found"],
	])("reports a %s user file as %s, distinct from the other states", async (_, raw, state) => {
		if (raw !== undefined) await fixture.writeRawJsonc(raw);

		const explanation = await explainProviderCatalog(options());

		expect(explanation.layers).toEqual([
			{ tag: "enforced", label: "admin enforced", detail: ENFORCED, state: "not set" },
			{ tag: "env", label: "connection env vars", detail: "", state: "not set" },
			{ tag: "user", label: "user providers.json", detail: fixture.configPath, state },
			{ tag: "default", label: "admin default", detail: DEFAULT, state: "not set" },
		]);
		expect(explanation.issues.length > 0).toBe(state === "invalid");
		// An unreadable file is discarded whole, engine settings included.
		expect(explanation.issues.every((issue) => issue.scope === "source")).toBe(true);
	});

	it("names, for a full stack, the layer whose value the resolver used", async () => {
		await fixture.writeTypedConfig({
			providers: {
				default: { enabled: false },
				anthropic: { enabled: true },
				openai: { baseUrl: "https://user.example/v1", models: { deny: ["gpt-4o"] } },
			},
			agentEngines: { enabled: true, claude: { enabled: true } },
		});
		const envVars = {
			[ENFORCED]: JSON.stringify({
				providers: { anthropic: { enabled: false } },
				agentEngines: { claude: { enabled: false } },
			}),
			[DEFAULT]: JSON.stringify({
				providers: {
					gemini: { enabled: true },
					openai: { baseUrl: "https://default.example/v1", models: { deny: ["o1", "o3"] } },
				},
			}),
			OPENAI_BASE_URL: "https://env.example/v1",
		};
		const extra = {
			legacyPositronEnforcedSettings: true,
			hostDefaults: { agentEngines: { codex: { enabled: true } } },
		};

		const explanation = await explainProviderCatalog(options(envVars, extra));
		const report = await loadProviderCatalogReport(options(envVars, extra));

		expect(explanation.layers.map(({ tag, state }) => [tag, state])).toEqual([
			["enforced", "found"],
			["legacy-enforced", "not set"],
			["env", "found"],
			["user", "found"],
			["default", "found"],
			["host", "found"],
		]);
		expect(traceAt(explanation, ["providers", "openai", "baseUrl"])).toEqual({
			path: ["providers", "openai", "baseUrl"],
			effective: "https://env.example/v1",
			rule: "highest-wins",
			layers: [
				{ layer: "$OPENAI_BASE_URL", value: "https://env.example/v1", status: "effective" },
				{ layer: "user", value: "https://user.example/v1", status: "overridden" },
				{ layer: "default", value: "https://default.example/v1", status: "overridden" },
			],
		});
		expect(traceAt(explanation, ["providers", "openai", "models", "deny"])).toMatchObject({
			effective: ["gpt-4o"],
			note: "lists replace, never merge",
			layers: [
				{ layer: "user", value: ["gpt-4o"], status: "effective" },
				{ layer: "default", value: ["o1", "o3"], status: "overridden" },
			],
		});
		expect(traceAt(explanation, ["providers", "anthropic", "enabled"])).toMatchObject({
			effective: false,
			layers: [
				{ layer: "enforced", value: false, status: "effective" },
				{ layer: "user", value: true, status: "no-effect" },
			],
		});
		// The user's providers.default outranks the default layer's own block.
		expect(traceAt(explanation, ["providers", "gemini", "enabled"])).toMatchObject({
			effective: false,
			note: "from providers.default in [user]",
			layers: [
				{ layer: "user", value: false, status: "effective" },
				{ layer: "default", value: true, status: "overridden" },
			],
		});
		expect(traceAt(explanation, ["providers", "default", "enabled"])).toMatchObject({
			effective: false,
			layers: [{ layer: "user", value: false, status: "effective" }],
		});
		expect(traceAt(explanation, ["agentEngines", "claude", "enabled"])).toMatchObject({
			effective: false,
			layers: [
				{ layer: "enforced", value: false, status: "effective" },
				{ layer: "user", value: true, status: "no-effect" },
			],
		});
		expect(traceAt(explanation, ["agentEngines", "codex", "enabled"])).toMatchObject({
			effective: true,
			layers: [{ layer: "host", value: true, status: "effective" }],
		});

		// Parity with the loaded catalog for every enablement and engine trace.
		for (const entry of explanation.entries) {
			if (entry.path[0] === "agentEngines") {
				expect(entry.effective).toEqual(leafAt(report.agentEngines, entry.path.slice(1)));
			} else if (entry.path.length === 3 && entry.path[2] === "enabled") {
				const provider = report.catalog.find(({ id }) => id === entry.path[1]);
				if (provider) expect(entry.effective).toBe(provider.enabled);
			}
		}
		expect(report.agentEnginesProvenance).toMatchObject({
			enabled: "user",
			claude: { enabled: "enforced" },
			codex: { enabled: "default" },
		});
	});

	it("keeps an engine setting from an overlay whose provider policy recovery drops", async () => {
		await fixture.writeTypedConfig({});
		const envVars = {
			// No source supplies the custom entry's `type`, so the merged stack
			// is invalid and the default overlay is dropped.
			[DEFAULT]: JSON.stringify({
				providers: { custom: { orphan: { baseUrl: "https://orphan.example" } } },
				agentEngines: { enabled: false },
			}),
		};

		const explanation = await explainProviderCatalog(options(envVars));
		const report = await loadProviderCatalogReport(options(envVars));

		expect(traceAt(explanation, ["providers", "custom", "orphan", "baseUrl"])).toMatchObject({
			effective: undefined,
			layers: [{ layer: "default", value: "https://orphan.example", status: "dropped" }],
		});
		expect(traceAt(explanation, ["agentEngines", "enabled"])).toMatchObject({
			effective: false,
			layers: [{ layer: "default", value: false, status: "effective" }],
		});
		expect(report.agentEngines).toEqual({ enabled: false });
		// Recovery dropped only the provider configuration; engine settings survive.
		expect(report.issues).toEqual([expect.objectContaining({ severity: "error" })]);
		expect(explanation.issues).toEqual([
			{
				severity: "error",
				path: [],
				scope: "providers",
				source: { kind: "default", label: DEFAULT },
			},
		]);
	});

	it("marks a lower Snowflake baseUrl dropped when a higher layer sets the account", async () => {
		await fixture.writeTypedConfig({
			providers: { "snowflake-cortex": { baseUrl: "https://user.snowflake.example" } },
		});

		const explanation = await explainProviderCatalog(options({ SNOWFLAKE_ACCOUNT: "acme" }));

		expect(traceAt(explanation, ["providers", "snowflake-cortex", "baseUrl"])).toMatchObject({
			effective: undefined,
			note: expect.stringContaining("one setting"),
			layers: [{ layer: "user", value: "https://user.snowflake.example", status: "dropped" }],
		});
		expect(
			traceAt(explanation, ["providers", "snowflake-cortex", "snowflake", "account"]),
		).toMatchObject({
			effective: "acme",
			layers: [{ layer: "$SNOWFLAKE_ACCOUNT", value: "acme", status: "effective" }],
		});
	});

	it("never shows a seeded secret, wherever it is seeded", async () => {
		const secret = (n: number) => `SEKRIT${n}x`;
		await fixture.writeTypedConfig({
			providers: {
				openai: {
					customHeaders: { "X-Tenant": secret(1) },
					apiKeyHelper: { command: `echo ${secret(2)}`, args: [secret(3)] },
				},
				anthropic: {
					baseUrl: `https://me:${secret(4)}@gateway.example/v1?token=${secret(5)}#${secret(6)}`,
				},
				custom: {
					gw: { type: "openai-compatible", customHeaders: { constructor: secret(7) } },
				},
			},
			agentEngines: {
				acp: {
					agent: {
						command: secret(8),
						args: [secret(9)],
						env: { TOKEN: secret(10) },
						displayName: secret(11),
					},
				},
			},
		});
		const envVars = {
			[ENFORCED]: `{"providers":{"openai":{"customHeaders":{"a":"${secret(12)}"}}`,
			[DEFAULT]: JSON.stringify({
				providers: { gemini: { baseUrl: 42, customHeaders: { b: secret(13) } } },
			}),
			POSITRON_ENFORCED_SETTINGS: `{"authentication.anthropic.baseUrl":"${secret(14)}"`,
			LITELLM_BASE_URL: `https://u:${secret(15)}@litellm.example?k=${secret(16)}`,
			OPENAI_BASE_URL: `https:///u:${secret(17)}@openai.example/v1`,
			GEMINI_BASE_URL: `https:/u:${secret(18)}@gemini.example/v1`,
			SNOWFLAKE_HOST: `u:${secret(19)}@acme.snowflakecomputing.com`,
		};

		const explanation = await explainProviderCatalog(
			options(envVars, { legacyPositronEnforcedSettings: true }),
		);

		const json = JSON.stringify(explanation);
		for (let n = 1; n <= 19; n++) {
			expect(json).not.toContain(secret(n));
		}
		expect(traceAt(explanation, ["providers", "openai", "apiKeyHelper"])?.effective).toBe(
			"<configured>",
		);
		expect(traceAt(explanation, ["agentEngines", "acp", "agent"])?.effective).toEqual({
			command: "<masked>",
			args: "<masked>",
			env: { TOKEN: "<masked>" },
			displayName: "<masked>",
		});
		expect(traceAt(explanation, ["providers", "anthropic", "baseUrl"])?.effective).toBe(
			"https://gateway.example/v1",
		);
		expect(
			traceAt(explanation, ["providers", "snowflake-cortex", "snowflake", "host"])?.effective,
		).toBe("acme.snowflakecomputing.com");
	});

	it.each([
		['{ "providers": { "openai": { "SEEDED": 1 } } }'],
		['{ "providers": { "openai": { "baseUrl": { "constructor": { "name": "SEEDED" } } } } }'],
	])("returns issues without parser text that quotes the input: %s", async (raw) => {
		await fixture.writeRawJsonc(raw);

		const explanation = await explainProviderCatalog(options());

		expect(explanation.issues).toEqual([
			{
				severity: "warning",
				path: ["providers", "openai"],
				scope: "source",
				source: { kind: "user", label: fixture.configPath },
			},
		]);
	});
});

describe("providers.json masking", () => {
	it("masks a field the safe-field declarations do not name", () => {
		expect(
			maskProvidersConfigValue(["providers", "openai"], {
				enabled: true,
				futureField: "x",
				customHeaders: { constructor: "y" },
			}),
		).toEqual({
			enabled: true,
			futureField: "<masked>",
			customHeaders: { constructor: "<masked>" },
		});
	});

	it.each([
		["https://user:pw@host.example/v1?k=v#frag", "https://host.example/v1"],
		["user:pw@host.example/path", "host.example/path"],
		["host.example:8080/v1", "host.example:8080/v1"],
		["https://host.example", "https://host.example"],
		["not a url@all", "all"],
		["  https://user:SEEDED@host.example/v1  ", "https://host.example/v1"],
		["//user:SEEDED@host.example/v1?k=v", "//host.example/v1"],
		[" //user:SEEDED@host.example ", "//host.example"],
		["https:///user:SEEDED@host.example/v1", "https://host.example/v1"],
		["https:/user:SEEDED@host.example/v1", "https://host.example/v1"],
		["https:\\\\user:SEEDED@host.example\\v1", "https://host.example/v1"],
		["user:SEEDED@account.snowflakecomputing.com", "account.snowflakecomputing.com"],
		["https://host.example/", "https://host.example/"],
		["https://host.example/?k=v", "https://host.example/"],
		["https://alice:1234/SEEDED@host.example/v1", "https://host.example/v1"],
		["https://u:123?SEEDED@host.example", "https://host.example"],
	])("strips userinfo, query and fragment from %s", (url, expected) => {
		expect(stripUrlSecrets(url)).toBe(expected);
	});

	it.each([
		["https://user:SEE/DED@host.example/v1"],
		["https://user:SEE#DED@host.example"],
		["https://user:SEE?DED@host.example"],
		["//user:SEE/DED@host.example"],
		["user:SEE/DED@host.example"],
		["https:user:SEEDED@host.example"],
		["foo:/user:SEEDED@host.example"],
		// Parseable: `URL` ends the authority inside the password.
		["https://alice:1234/SEE/DED@host.example/v1"],
		["https://abcSEE/xyzDED@host.example/v1"],
		["https://u:123?SEE#DED@host.example"],
		["https://alice@SEE/DED@host.example/v1"],
		["https://a@b:1?SEEDED@host.example"],
	])("keeps no text that could be a password in %s", (url) => {
		expect(stripUrlSecrets(url)).not.toMatch(/SEE|DED|alice|1234|abc|u:123|b:1/);
	});

	it.each([["host"], ["account"]])("shows a Snowflake %s without userinfo", (field) => {
		expect(
			maskProvidersConfigValue(
				["providers", "snowflake-cortex", "snowflake", field],
				"user:SEEDED@acme.snowflakecomputing.com",
			),
		).toBe("acme.snowflakecomputing.com");
	});

	it("shows an ordinary Snowflake account unchanged", () => {
		expect(
			maskProvidersConfigValue(
				["providers", "snowflake-cortex", "snowflake", "account"],
				"acme-xy123",
			),
		).toBe("acme-xy123");
	});
});
