/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from "vitest";

import type { ProviderConfigSource } from "../resolve-catalog.js";
import {
	recoverValidStack,
	resolveProviderCatalog,
	resolveProviderCatalogReport,
} from "../resolve-catalog.js";
import type { PlatformBaseline, ResolvedProvider } from "../types.js";

const STANDALONE: PlatformBaseline = { defaultEnabled: true };

function find(catalog: readonly ResolvedProvider[], id: string): ResolvedProvider | undefined {
	return catalog.find((p) => (p.id as string) === id);
}

function source(
	kind: ProviderConfigSource["kind"],
	config: ProviderConfigSource["config"],
): ProviderConfigSource {
	return { kind, config };
}

describe("resolveProviderCatalog — precedence", () => {
	it("orders sources by kind, not array position", () => {
		// Pass sources out of precedence order; result must still honor rank.
		const catalog = resolveProviderCatalog({
			sources: [
				source("default", { providers: { anthropic: { enabled: true } } }),
				source("enforced", { providers: { anthropic: { enabled: false } } }),
				source("user", { providers: { anthropic: { enabled: true } } }),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(catalog, "anthropic")?.enabled).toBe(false);
	});

	it("legacy-positron sits below user, above default (enablement)", () => {
		// user disables → wins over legacy-positron enabling.
		const c1 = resolveProviderCatalog({
			sources: [
				source("user", { providers: { anthropic: { enabled: false } } }),
				source("legacy-positron", { providers: { anthropic: { enabled: true } } }),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(c1, "anthropic")?.enabled).toBe(false);

		// legacy-positron disables → wins over default enabling.
		const c2 = resolveProviderCatalog({
			sources: [
				source("legacy-positron", { providers: { openai: { enabled: false } } }),
				source("default", { providers: { openai: { enabled: true } } }),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(c2, "openai")?.enabled).toBe(false);
	});

	it("default layer applies when user/legacy-positron are silent", () => {
		const catalog = resolveProviderCatalog({
			sources: [source("default", { providers: { default: { enabled: false } } })],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(catalog, "anthropic")?.enabled).toBe(false);
	});
});

describe("resolveProviderCatalog — sealed enforced overlay", () => {
	it("enforced connection can never be overridden by lower sources", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("enforced", {
					providers: { anthropic: { baseUrl: "https://enforced.example.com" } },
				}),
				source("user", { providers: { anthropic: { baseUrl: "https://user.example.com" } } }),
				source("default", {
					providers: { anthropic: { baseUrl: "https://default.example.com" } },
				}),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(catalog, "anthropic")?.connection.baseUrl).toBe("https://enforced.example.com");
	});

	it("customHeaders enforce per leaf-key (admin-pinned keys non-strippable, user keys kept)", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("enforced", {
					providers: { anthropic: { customHeaders: { "x-admin": "pinned", "x-team": "admin" } } },
				}),
				source("user", {
					providers: { anthropic: { customHeaders: { "x-team": "user", "x-extra": "ok" } } },
				}),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(catalog, "anthropic")?.connection.customHeaders).toEqual({
			"x-admin": "pinned", // admin-pinned
			"x-team": "admin", // enforced wins over user's same key
			"x-extra": "ok", // user's other key preserved
		});
	});

	it("allow/deny arrays replace wholesale (never widen)", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("enforced", { providers: { anthropic: { models: { allow: ["only-this"] } } } }),
				source("user", {
					providers: { anthropic: { models: { allow: ["a", "b", "c"] } } },
				}),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(catalog, "anthropic")?.models?.allow).toEqual(["only-this"]);
	});
});

describe("resolveProviderCatalog — invalid merge tolerance", () => {
	it("drops only the offending overlay, keeping other valid sources", () => {
		const logger = { debug: vi.fn(), warn: vi.fn() };
		const catalog = resolveProviderCatalog({
			sources: [
				// enforced introduces a custom entry with no `type`; no other source
				// supplies it → this source's merge is invalid and it is dropped.
				source("enforced", { providers: { custom: { "ghost-gw": { enabled: false } } } }),
				source("user", { providers: { anthropic: { enabled: true } } }),
			],
			baseline: STANDALONE,
			envVars: {},
			logger,
		});

		// 15 built-ins, no custom provider leaked in.
		expect(catalog.length).toBe(15);
		expect(find(catalog, "ghost-gw")).toBeUndefined();
		expect(find(catalog, "anthropic")?.enabled).toBe(true);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("invalid merged result"));
	});

	it("an invalid enforced/default source does not erase a valid legacy-positron source", () => {
		const logger = { debug: vi.fn(), warn: vi.fn() };
		const catalog = resolveProviderCatalog({
			sources: [
				// Invalid overlay (custom without type) — must be dropped alone.
				source("enforced", { providers: { custom: { ghost: { enabled: false } } } }),
				source("user", { providers: {} }),
				// A valid legacy-positron source (legacy Positron settings) sits below
				// enforced; it must survive the enforced source being dropped.
				source("legacy-positron", { providers: { anthropic: { enabled: false } } }),
			],
			baseline: STANDALONE,
			envVars: {},
			logger,
		});

		expect(find(catalog, "ghost")).toBeUndefined();
		// The legacy-positron source's decision is preserved (user is silent on anthropic).
		expect(find(catalog, "anthropic")?.enabled).toBe(false);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("invalid merged result"));
	});
});

describe("resolveProviderCatalog — tightened-schema recovery", () => {
	it("drops a non-user overlay carrying a now-forbidden subsection, continuing resolution", () => {
		const logger = { debug: vi.fn(), warn: vi.fn() };
		const catalog = resolveProviderCatalog({
			sources: [
				// `anthropic.aws` is a foreign section under the tightened schema. The
				// enforced overlay's merged result is invalid → the overlay is dropped.
				source("enforced", {
					providers: { anthropic: { aws: { region: "us-east-1" } } },
				}),
				source("user", { providers: { openai: { enabled: true } } }),
			],
			baseline: STANDALONE,
			envVars: {},
			logger,
		});

		// The valid user source still resolves; the forbidden overlay is gone.
		expect(catalog.length).toBe(15);
		expect(find(catalog, "openai")?.enabled).toBe(true);
		expect(find(catalog, "anthropic")?.connection.aws).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("invalid merged result"));
	});

	it("keeps a valid legacy-positron overlay when a forbidden default overlay is dropped", () => {
		const logger = { debug: vi.fn(), warn: vi.fn() };
		const catalog = resolveProviderCatalog({
			sources: [
				source("user", { providers: {} }),
				// A valid legacy-positron overlay must survive the forbidden default being dropped.
				source("legacy-positron", { providers: { anthropic: { enabled: false } } }),
				// `bedrock.snowflake` is a wrong-capability section → invalid, dropped.
				source("default", {
					providers: { bedrock: { snowflake: { account: "MYORG" } } },
				}),
			],
			baseline: STANDALONE,
			envVars: {},
			logger,
		});

		expect(find(catalog, "anthropic")?.enabled).toBe(false);
		expect(find(catalog, "bedrock")?.connection.snowflake).toBeUndefined();
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("invalid merged result"));
	});
});

describe("resolveProviderCatalog — cross-layer custom completion", () => {
	it("keeps a lower partial custom source completed by a higher source", () => {
		const logger = { debug: vi.fn(), warn: vi.fn() };
		const catalog = resolveProviderCatalog({
			sources: [
				// user (higher) supplies the required `type` + baseUrl.
				source("user", {
					providers: {
						custom: { gateway: { type: "openai-compatible", baseUrl: "https://gw.example.com" } },
					},
				}),
				// default (lower) supplies only enabled=false — valid ONLY because
				// user completes the entry's `type` in the full stack.
				source("default", { providers: { custom: { gateway: { enabled: false } } } }),
			],
			baseline: STANDALONE,
			envVars: {},
			logger,
		});

		const gw = find(catalog, "gateway");
		expect(gw).toBeDefined();
		expect(gw?.clientKind).toBe("openai-compatible");
		expect(gw?.connection.baseUrl).toBe("https://gw.example.com");
		// The lower layer's intended default (enabled=false) is honored, not lost.
		expect(gw?.enabled).toBe(false);
		// Nothing was dropped, so no invalid-source warning.
		expect(logger.warn).not.toHaveBeenCalled();
	});

	it("keeps a higher partial custom source completed by a lower source", () => {
		const logger = { debug: vi.fn(), warn: vi.fn() };
		const catalog = resolveProviderCatalog({
			sources: [
				// enforced (higher) sets only enabled — no `type`.
				source("enforced", { providers: { custom: { gateway: { enabled: false } } } }),
				// user (lower) supplies the required `type`.
				source("user", {
					providers: { custom: { gateway: { type: "openai-compatible" } } },
				}),
			],
			baseline: STANDALONE,
			envVars: {},
			logger,
		});

		const gw = find(catalog, "gateway");
		expect(gw).toBeDefined();
		expect(gw?.clientKind).toBe("openai-compatible");
		// enforced's enabled=false wins (sealed, above user).
		expect(gw?.enabled).toBe(false);
		expect(logger.warn).not.toHaveBeenCalled();
	});
});

describe("resolveProviderCatalog — same-kind ordering", () => {
	it("earlier array entry wins among sources of the same kind (connection + enablement)", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				// Two legacy-positron sources; the earlier one should win for both connection
				// and enablement.
				source("legacy-positron", {
					providers: { anthropic: { enabled: true, baseUrl: "https://first.example.com" } },
				}),
				source("legacy-positron", {
					providers: { anthropic: { enabled: false, baseUrl: "https://second.example.com" } },
				}),
			],
			baseline: STANDALONE,
			envVars: {},
		});

		expect(find(catalog, "anthropic")?.connection.baseUrl).toBe("https://first.example.com");
		expect(find(catalog, "anthropic")?.enabled).toBe(true);
	});
});

// PROVIDER-SETTINGS-MIGRATION(legacy-positron) gate: delete this block with the source kind.
describe("resolveProviderCatalog — legacy-positron layer merge semantics", () => {
	// These pin the three declared merge-semantic changes from relocating the
	// Positron `authentication.*` dual-read into a `legacy-positron` source: the resolver
	// deep-merges object keys where the old adapter did whole-field fallback.

	it("customHeaders deep-merge across user + legacy-positron (user wins per key)", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("user", {
					providers: { anthropic: { customHeaders: { "x-team": "user", "x-user-only": "u" } } },
				}),
				source("legacy-positron", {
					providers: { anthropic: { customHeaders: { "x-team": "host", "x-host-only": "h" } } },
				}),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(catalog, "anthropic")?.connection.customHeaders).toEqual({
			"x-team": "user", // user wins on collision (legacy-positron is the fallback below it)
			"x-user-only": "u", // user's own key preserved
			"x-host-only": "h", // host's non-colliding key merged in
		});
	});

	it("snowflake host/account merge across user + host (both keys resolve)", () => {
		// user sets only account; legacy-positron sets only host → the merged connection
		// carries both. `host` wins over `account` when the URL is built downstream
		// (that preference is in ai-credentials' shapeCredentials — see its tests).
		const catalog = resolveProviderCatalog({
			sources: [
				source("user", {
					providers: { "snowflake-cortex": { snowflake: { account: "user-acct" } } },
				}),
				source("legacy-positron", {
					providers: { "snowflake-cortex": { snowflake: { host: "host.snowflakecomputing.com" } } },
				}),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(catalog, "snowflake-cortex")?.connection.snowflake).toEqual({
			host: "host.snowflakecomputing.com",
			account: "user-acct",
		});
	});

	it("snowflake home merges across user + host like the other snowflake keys", () => {
		// legacy-positron (the transitional authentication.* layer) supplies home; user
		// supplies account → the merged connection carries both.
		const catalog = resolveProviderCatalog({
			sources: [
				source("user", {
					providers: { "snowflake-cortex": { snowflake: { account: "user-acct" } } },
				}),
				source("legacy-positron", {
					providers: { "snowflake-cortex": { snowflake: { home: "/managed/snowflake" } } },
				}),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		// Typed access to `.home` is the point: it fails check-types until
		// ResolvedConnection.snowflake carries the field.
		const resolved = find(catalog, "snowflake-cortex")?.connection.snowflake;
		expect(resolved?.home).toBe("/managed/snowflake");
		expect(resolved?.account).toBe("user-acct");
	});

	it("AWS region ordering: env > legacy authentication setting > unset", () => {
		// legacy setting surfaces in the resolved connection (revival of the
		// previously-dead authentication.aws.credentials.AWS_REGION).
		const hostOnly = resolveProviderCatalog({
			sources: [
				source("legacy-positron", { providers: { bedrock: { aws: { region: "eu-west-1" } } } }),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(hostOnly, "bedrock")?.connection.aws?.region).toBe("eu-west-1");

		// env AWS_REGION still beats the legacy setting (env overlay > legacy-positron).
		const withEnv = resolveProviderCatalog({
			sources: [
				source("legacy-positron", { providers: { bedrock: { aws: { region: "eu-west-1" } } } }),
			],
			baseline: STANDALONE,
			envVars: { AWS_REGION: "ap-south-1" },
		});
		expect(find(withEnv, "bedrock")?.connection.aws?.region).toBe("ap-south-1");

		// no legacy setting, no env → no region in the resolved connection.
		// The us-east-1 default is applied later, at credential-synthesis time,
		// so it doesn't outrank the user's stored credential region.
		const defaultOnly = resolveProviderCatalog({
			sources: [source("user", { providers: {} })],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(defaultOnly, "bedrock")?.connection.aws?.region).toBeUndefined();
	});

	it("preserves whether the effective AWS region is ambient-only or deliberately configured", () => {
		const ambientOnly = resolveProviderCatalog({
			sources: [],
			baseline: STANDALONE,
			envVars: { AWS_REGION: "us-west-2" },
		});
		expect(find(ambientOnly, "bedrock")?.connectionProvenance.aws?.region).toBe("environment");

		const enforcedEqualToEnv = resolveProviderCatalog({
			sources: [
				source("enforced", {
					providers: { bedrock: { aws: { region: "us-west-2" } } },
				}),
			],
			baseline: STANDALONE,
			envVars: { AWS_REGION: "us-west-2" },
		});
		expect(find(enforcedEqualToEnv, "bedrock")?.connectionProvenance.aws?.region).toBe(
			"configuration",
		);

		const userEqualToEnv = resolveProviderCatalog({
			sources: [
				source("user", {
					providers: { bedrock: { aws: { region: "us-west-2" } } },
				}),
			],
			baseline: STANDALONE,
			envVars: { AWS_REGION: "us-west-2" },
		});
		expect(find(userEqualToEnv, "bedrock")?.connectionProvenance.aws?.region).toBe("configuration");

		const envOverridesDifferentUserValue = resolveProviderCatalog({
			sources: [
				source("user", {
					providers: { bedrock: { aws: { region: "eu-west-1" } } },
				}),
			],
			baseline: STANDALONE,
			envVars: { AWS_REGION: "us-west-2" },
		});
		expect(find(envOverridesDifferentUserValue, "bedrock")?.connectionProvenance.aws?.region).toBe(
			"environment",
		);
	});
});

describe("resolveProviderCatalog — enforced beats connection env", () => {
	it("enforced baseUrl wins over connection env var", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("enforced", {
					providers: { anthropic: { baseUrl: "https://enforced.example.com" } },
				}),
				source("user", { providers: {} }),
			],
			baseline: STANDALONE,
			envVars: { ANTHROPIC_BASE_URL: "https://env.example.com" },
		});
		expect(find(catalog, "anthropic")?.connection.baseUrl).toBe("https://enforced.example.com");
	});

	it("env beats user/default when no enforced source pins the field", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("user", {
					providers: { anthropic: { baseUrl: "https://user.example.com" } },
				}),
				source("default", {
					providers: { anthropic: { baseUrl: "https://default.example.com" } },
				}),
			],
			baseline: STANDALONE,
			envVars: { ANTHROPIC_BASE_URL: "https://env.example.com" },
		});
		expect(find(catalog, "anthropic")?.connection.baseUrl).toBe("https://env.example.com");
	});

	it("enforced positaiLogin.host wins over POSITAI_AUTH_HOST env, env-only sub-key still lands", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("enforced", {
					providers: { positai: { positaiLogin: { host: "enforced.login.com" } } },
				}),
				source("user", { providers: {} }),
			],
			baseline: STANDALONE,
			envVars: {
				POSITAI_AUTH_HOST: "env.login.com",
				POSITAI_CLIENT_ID: "env-client-id",
			},
		});
		const login = find(catalog, "positai")?.connection.positaiLogin;
		// Enforced host wins over env
		expect(login?.host).toBe("enforced.login.com");
		// Env-only sub-key (clientId not in enforced) still lands
		expect(login?.clientId).toBe("env-client-id");
	});
});

describe("resolveProviderCatalog — snowflake + legacy vertex env vars", () => {
	it("folds SNOWFLAKE_* env vars into snowflake-cortex connection", () => {
		const catalog = resolveProviderCatalog({
			sources: [],
			baseline: STANDALONE,
			envVars: {
				SNOWFLAKE_ACCOUNT: "acme-prod",
				SNOWFLAKE_HOST: "acme-prod.privatelink.snowflakecomputing.com",
				SNOWFLAKE_HOME: "/opt/sf",
			},
		});
		expect(find(catalog, "snowflake-cortex")?.connection.snowflake).toEqual({
			account: "acme-prod",
			host: "acme-prod.privatelink.snowflakecomputing.com",
			home: "/opt/sf",
		});
	});

	it("folds DATABRICKS_HOST into databricks connection (not baseUrl)", () => {
		const catalog = resolveProviderCatalog({
			sources: [],
			baseline: STANDALONE,
			envVars: { DATABRICKS_HOST: "https://adb-123.4.azuredatabricks.net" },
		});
		expect(find(catalog, "databricks")?.connection.databricks).toEqual({
			host: "https://adb-123.4.azuredatabricks.net",
		});
		expect(find(catalog, "databricks")?.connection.baseUrl).toBeUndefined();
	});

	it("maps GOOGLE_VERTEX_BASE_URL to google-vertex baseUrl", () => {
		const catalog = resolveProviderCatalog({
			sources: [],
			baseline: STANDALONE,
			envVars: { GOOGLE_VERTEX_BASE_URL: "https://vertex.example.com" },
		});
		expect(find(catalog, "google-vertex")?.connection.baseUrl).toBe("https://vertex.example.com");
	});

	it("legacy GOOGLE_VERTEX_* names apply only when GOOGLE_CLOUD_* are unset", () => {
		const legacyOnly = resolveProviderCatalog({
			sources: [],
			baseline: STANDALONE,
			envVars: { GOOGLE_VERTEX_PROJECT: "legacy-proj", GOOGLE_VERTEX_LOCATION: "us-west1" },
		});
		expect(find(legacyOnly, "google-vertex")?.connection.googleCloud).toEqual({
			project: "legacy-proj",
			location: "us-west1",
		});

		const primaryWins = resolveProviderCatalog({
			sources: [],
			baseline: STANDALONE,
			envVars: {
				GOOGLE_CLOUD_PROJECT: "primary-proj",
				GOOGLE_VERTEX_PROJECT: "legacy-proj",
				GOOGLE_VERTEX_LOCATION: "us-west1",
			},
		});
		// Primary project wins; legacy location still fills the unset field.
		expect(find(primaryWins, "google-vertex")?.connection.googleCloud).toEqual({
			project: "primary-proj",
			location: "us-west1",
		});
	});
});

describe("recoverValidStack — choose dropped source", () => {
	/** Custom entry with no `type` — uncompletable unless another source supplies it. */
	const badCustom = (name: string): ProviderConfigSource["config"] => ({
		providers: { custom: { [name]: { enabled: false } } },
	});

	function keptKinds(sources: readonly { readonly kind: string }[]): string[] {
		return sources.map((s) => s.kind);
	}

	it("keeps the whole stack when the full merge is valid", () => {
		const sources = [
			source("enforced", { providers: { anthropic: { enabled: false } } }),
			source("user", { providers: {} }),
			source("legacy-positron", { providers: { openai: { enabled: true } } }),
		];
		const { kept, config } = recoverValidStack(sources);
		expect(keptKinds(kept)).toEqual(["enforced", "user", "legacy-positron"]);
		expect(config.providers?.anthropic?.enabled).toBe(false);
	});

	it("drops the single offending overlay, preserving unrelated valid overlays", () => {
		// enforced is the culprit; user + legacy-positron must survive.
		const sources = [
			source("enforced", badCustom("ghost")),
			source("user", { providers: {} }),
			source("legacy-positron", { providers: { anthropic: { enabled: false } } }),
		];
		const { kept } = recoverValidStack(sources);
		expect(keptKinds(kept)).toEqual(["user", "legacy-positron"]);
	});

	it("does not over-remove: keeps a good enforced above a bad default", () => {
		// The bad source is the lower `default`; the higher `enforced` is fine.
		const sources = [
			source("enforced", { providers: { anthropic: { baseUrl: "https://a.example.com" } } }),
			source("user", { providers: {} }),
			source("default", badCustom("ghost")),
		];
		const { kept } = recoverValidStack(sources);
		expect(keptKinds(kept)).toEqual(["enforced", "user"]);
	});

	it("drops multiple uncompletable overlays, keeping the authoritative user source", () => {
		// No single removal fixes it; both relaxed overlays must go.
		const sources = [
			source("enforced", badCustom("ghost-a")),
			source("user", { providers: { anthropic: { enabled: true } } }),
			source("default", badCustom("ghost-b")),
		];
		const logger = { debug: vi.fn(), warn: vi.fn() };
		const { kept, config } = recoverValidStack(sources, logger);
		expect(keptKinds(kept)).toEqual(["user"]);
		expect(config.providers?.anthropic?.enabled).toBe(true);
		// A warning was emitted for each dropped source.
		expect(logger.warn).toHaveBeenCalledTimes(2);
	});

	it("returns dropped-overlay source identity through the resolver report", () => {
		const report = resolveProviderCatalogReport({
			sources: [
				{ kind: "enforced", label: "TEST_ENFORCED", config: badCustom("ghost") },
				source("user", { providers: { anthropic: { enabled: true } } }),
			],
			baseline: STANDALONE,
			envVars: {},
		});

		expect(find(report.catalog, "anthropic")?.enabled).toBe(true);
		expect(report.issues).toEqual([
			expect.objectContaining({
				source: { kind: "enforced", label: "TEST_ENFORCED" },
				message: expect.stringContaining("invalid merged result"),
			}),
		]);
		expect(
			resolveProviderCatalog({
				sources: [source("user", {})],
				baseline: STANDALONE,
				envVars: {},
			}),
		).toBeInstanceOf(Array);
	});
});

// PROVIDER-SETTINGS-MIGRATION(legacy-positron) gate: delete this block with the source kind.
describe("resolveProviderCatalog — legacy-positron-enforced (legacy Positron enforcement)", () => {
	it("legacy-positron-enforced beats user, legacy-positron, and default (connection)", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("legacy-positron-enforced", {
					providers: { anthropic: { baseUrl: "https://legacy-enforced.example.com" } },
				}),
				source("user", { providers: { anthropic: { baseUrl: "https://user.example.com" } } }),
				source("legacy-positron", {
					providers: { anthropic: { baseUrl: "https://legacy.example.com" } },
				}),
				source("default", {
					providers: { anthropic: { baseUrl: "https://default.example.com" } },
				}),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(catalog, "anthropic")?.connection.baseUrl).toBe(
			"https://legacy-enforced.example.com",
		);
	});

	it("legacy-positron-enforced beats connection env vars", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("legacy-positron-enforced", {
					providers: { anthropic: { baseUrl: "https://legacy-enforced.example.com" } },
				}),
				source("user", { providers: {} }),
			],
			baseline: STANDALONE,
			envVars: { ANTHROPIC_BASE_URL: "https://env.example.com" },
		});
		expect(find(catalog, "anthropic")?.connection.baseUrl).toBe(
			"https://legacy-enforced.example.com",
		);
	});

	it("legacy-positron-enforced enablement beats user", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("legacy-positron-enforced", { providers: { anthropic: { enabled: false } } }),
				source("user", { providers: { anthropic: { enabled: true } } }),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(catalog, "anthropic")?.enabled).toBe(false);
	});

	it("legacy-positron-enforced models beat user (custom replaces wholesale)", () => {
		const enforcedModel = {
			id: "team-model",
			name: "Team Model",
			maxContextLength: 100_000,
			supportsTools: true,
			supportsImages: false,
			supportsToolResultImages: false,
			supportsWebSearch: false,
		};
		const catalog = resolveProviderCatalog({
			sources: [
				source("legacy-positron-enforced", {
					providers: {
						anthropic: { models: { discovery: "off", custom: [enforcedModel] } },
					},
				}),
				source("user", {
					providers: {
						anthropic: {
							models: {
								discovery: "auto",
								custom: [{ ...enforcedModel, id: "user-model", name: "User Model" }],
							},
						},
					},
				}),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		const models = find(catalog, "anthropic")?.models;
		expect(models?.discovery).toBe("off");
		expect(models?.custom?.map((m) => m.id)).toEqual(["team-model"]);
	});

	it("canonical enforced still beats legacy-positron-enforced", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("legacy-positron-enforced", {
					providers: { anthropic: { baseUrl: "https://legacy-enforced.example.com" } },
				}),
				source("enforced", {
					providers: { anthropic: { baseUrl: "https://enforced.example.com" } },
				}),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(catalog, "anthropic")?.connection.baseUrl).toBe("https://enforced.example.com");
	});

	it("an enforced key pins that key only — user-set sibling keys remain", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("legacy-positron-enforced", {
					providers: { anthropic: { baseUrl: "https://legacy-enforced.example.com" } },
				}),
				source("user", {
					providers: { anthropic: { customHeaders: { "x-team": "user" } } },
				}),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		const connection = find(catalog, "anthropic")?.connection;
		expect(connection?.baseUrl).toBe("https://legacy-enforced.example.com");
		expect(connection?.customHeaders).toEqual({ "x-team": "user" });
	});

	it("an invalid legacy-positron-enforced overlay is dropped alone, with a warning", () => {
		const logger = { debug: vi.fn(), warn: vi.fn() };
		const catalog = resolveProviderCatalog({
			sources: [
				// Custom entry with no `type` that no other source completes →
				// this overlay's merge is invalid and it is dropped by recovery.
				source("legacy-positron-enforced", {
					providers: { custom: { ghost: { enabled: false } } },
				}),
				source("user", { providers: { anthropic: { enabled: true } } }),
			],
			baseline: STANDALONE,
			envVars: {},
			logger,
		});
		expect(find(catalog, "ghost")).toBeUndefined();
		expect(find(catalog, "anthropic")?.enabled).toBe(true);
		expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("invalid merged result"));
	});
});
