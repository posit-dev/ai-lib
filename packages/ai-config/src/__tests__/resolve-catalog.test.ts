/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from "vitest";

import type { ProviderConfigSource } from "../resolve-catalog.js";
import { recoverValidStack, resolveProviderCatalog } from "../resolve-catalog.js";
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

	it("host sits below user, above default (enablement)", () => {
		// user disables → wins over host enabling.
		const c1 = resolveProviderCatalog({
			sources: [
				source("user", { providers: { anthropic: { enabled: false } } }),
				source("host", { providers: { anthropic: { enabled: true } } }),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(c1, "anthropic")?.enabled).toBe(false);

		// host disables → wins over default enabling.
		const c2 = resolveProviderCatalog({
			sources: [
				source("host", { providers: { openai: { enabled: false } } }),
				source("default", { providers: { openai: { enabled: true } } }),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(c2, "openai")?.enabled).toBe(false);
	});

	it("default layer applies when user/host are silent", () => {
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

	it("an invalid enforced/default source does not erase a valid host source", () => {
		const logger = { debug: vi.fn(), warn: vi.fn() };
		const catalog = resolveProviderCatalog({
			sources: [
				// Invalid overlay (custom without type) — must be dropped alone.
				source("enforced", { providers: { custom: { ghost: { enabled: false } } } }),
				source("user", { providers: {} }),
				// A valid host source (e.g. Positron authentication.*) sits below
				// enforced; it must survive the enforced source being dropped.
				source("host", { providers: { anthropic: { enabled: false } } }),
			],
			baseline: STANDALONE,
			envVars: {},
			logger,
		});

		expect(find(catalog, "ghost")).toBeUndefined();
		// The host source's decision is preserved (user is silent on anthropic).
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

	it("keeps a valid host overlay when a forbidden default overlay is dropped", () => {
		const logger = { debug: vi.fn(), warn: vi.fn() };
		const catalog = resolveProviderCatalog({
			sources: [
				source("user", { providers: {} }),
				// A valid host overlay must survive the forbidden default being dropped.
				source("host", { providers: { anthropic: { enabled: false } } }),
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
				// Two host sources; the earlier one should win for both connection
				// and enablement.
				source("host", {
					providers: { anthropic: { enabled: true, baseUrl: "https://first.example.com" } },
				}),
				source("host", {
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

describe("resolveProviderCatalog — host layer merge semantics (Phase 6)", () => {
	// These pin the three declared merge-semantic changes from relocating the
	// Positron `authentication.*` dual-read into a `host` source: the resolver
	// deep-merges object keys where the old adapter did whole-field fallback.

	it("customHeaders deep-merge across user + host (user wins per key)", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("user", {
					providers: { anthropic: { customHeaders: { "x-team": "user", "x-user-only": "u" } } },
				}),
				source("host", {
					providers: { anthropic: { customHeaders: { "x-team": "host", "x-host-only": "h" } } },
				}),
			],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(catalog, "anthropic")?.connection.customHeaders).toEqual({
			"x-team": "user", // user wins on collision (host is the fallback below it)
			"x-user-only": "u", // user's own key preserved
			"x-host-only": "h", // host's non-colliding key merged in
		});
	});

	it("snowflake host/account merge across user + host (both keys resolve)", () => {
		// user sets only account; host sets only host → the merged connection
		// carries both. `host` wins over `account` when the URL is built downstream
		// (that preference is in ai-credentials' shapeCredentials — see its tests).
		const catalog = resolveProviderCatalog({
			sources: [
				source("user", {
					providers: { "snowflake-cortex": { snowflake: { account: "user-acct" } } },
				}),
				source("host", {
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

	it("AWS region ordering: env > host authentication setting > us-east-1 default", () => {
		// host setting beats the us-east-1 default (revival of the previously-dead
		// authentication.aws.credentials.AWS_REGION).
		const hostOnly = resolveProviderCatalog({
			sources: [source("host", { providers: { bedrock: { aws: { region: "eu-west-1" } } } })],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(hostOnly, "bedrock")?.connection.aws?.region).toBe("eu-west-1");

		// env AWS_REGION still beats the host setting (env overlay > host).
		const withEnv = resolveProviderCatalog({
			sources: [source("host", { providers: { bedrock: { aws: { region: "eu-west-1" } } } })],
			baseline: STANDALONE,
			envVars: { AWS_REGION: "ap-south-1" },
		});
		expect(find(withEnv, "bedrock")?.connection.aws?.region).toBe("ap-south-1");

		// no host, no env → the us-east-1 default.
		const defaultOnly = resolveProviderCatalog({
			sources: [source("user", { providers: {} })],
			baseline: STANDALONE,
			envVars: {},
		});
		expect(find(defaultOnly, "bedrock")?.connection.aws?.region).toBe("us-east-1");
	});
});

describe("recoverValidStack — choose dropped source", () => {
	/** Custom entry with no `type` — uncompletable unless another source supplies it. */
	const badCustom = (name: string): ProviderConfigSource["config"] => ({
		providers: { custom: { [name]: { enabled: false } } },
	});

	function keptKinds(sources: readonly ProviderConfigSource[]): string[] {
		return sources.map((s) => s.kind);
	}

	it("keeps the whole stack when the full merge is valid", () => {
		const sources = [
			source("enforced", { providers: { anthropic: { enabled: false } } }),
			source("user", { providers: {} }),
			source("host", { providers: { openai: { enabled: true } } }),
		];
		const { kept, config } = recoverValidStack(sources);
		expect(keptKinds(kept)).toEqual(["enforced", "user", "host"]);
		expect(config.providers?.anthropic?.enabled).toBe(false);
	});

	it("drops the single offending overlay, preserving unrelated valid overlays", () => {
		// enforced is the culprit; user + host must survive.
		const sources = [
			source("enforced", badCustom("ghost")),
			source("user", { providers: {} }),
			source("host", { providers: { anthropic: { enabled: false } } }),
		];
		const { kept } = recoverValidStack(sources);
		expect(keptKinds(kept)).toEqual(["user", "host"]);
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
});
