/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import type { ConfigFileFixture } from "../../tests/helpers/config-file-fixture.js";
import { loadProviderCatalogReport } from "../node/load-catalog.js";
import { mutateProvidersConfig } from "../node/mutate-config.js";
import { resolveProviderCatalogReport } from "../resolve-catalog.js";

const ENFORCED = "TEST_AGENT_ENGINES_ENFORCED";
const DEFAULT = "TEST_AGENT_ENGINES_DEFAULT";

describe("agentEngines resolution", () => {
	let fixture: ConfigFileFixture;

	beforeEach(async () => {
		fixture = await createConfigFileFixture();
	});

	afterEach(async () => {
		await fixture.cleanup();
	});

	async function load(env: { enforced?: unknown; default?: unknown } = {}) {
		return loadProviderCatalogReport({
			configPath: fixture.configPath,
			enforcedEnvVar: ENFORCED,
			defaultEnvVar: DEFAULT,
			envVars: {
				...(env.enforced !== undefined ? { [ENFORCED]: JSON.stringify(env.enforced) } : {}),
				...(env.default !== undefined ? { [DEFAULT]: JSON.stringify(env.default) } : {}),
			},
		});
	}

	it("is empty when no layer sets it", async () => {
		const report = await load();
		expect(report.agentEngines).toEqual({});
	});

	it("lets an enforced master switch beat the user's enabled engine", async () => {
		await fixture.writeTypedConfig({
			agentEngines: { enabled: true, claude: { enabled: true, configDir: "~/claude" } },
		});

		const report = await load({ enforced: { agentEngines: { enabled: false } } });

		expect(report.agentEngines).toEqual({
			enabled: false,
			claude: { enabled: true, configDir: "~/claude" },
		});
	});

	it("takes an engine enabled by the default layer, with user fields merged per leaf", async () => {
		await fixture.writeTypedConfig({
			agentEngines: { copilot: { defaultModel: "gpt-5" } },
		});

		const report = await load({ default: { agentEngines: { copilot: { enabled: true } } } });

		expect(report.agentEngines).toEqual({ copilot: { enabled: true, defaultModel: "gpt-5" } });
	});

	it("replaces the user's same-id ACP agent wholesale with the enforced one", async () => {
		await fixture.writeTypedConfig({
			agentEngines: {
				acp: {
					gemini: { command: "gemini", args: ["--acp", "--yolo"], env: { DEBUG: "1" } },
					mine: { command: "my-agent" },
				},
			},
		});

		const report = await load({
			enforced: { agentEngines: { acp: { gemini: { command: "/opt/gemini" } } } },
		});

		expect(report.agentEngines.acp).toEqual({
			gemini: { command: "/opt/gemini" },
			mine: { command: "my-agent" },
		});
	});

	it("drops a command-less enforced ACP agent but keeps the master switch and providers", async () => {
		await fixture.writeTypedConfig({
			agentEngines: { acp: { gemini: { command: "gemini", args: ["--acp"] } } },
		});

		const report = await load({
			enforced: {
				providers: { anthropic: { enabled: false } },
				agentEngines: { enabled: false, acp: { gemini: { args: ["--acp"] } } },
			},
		});

		expect(report.agentEngines).toEqual({
			enabled: false,
			acp: { gemini: { command: "gemini", args: ["--acp"] } },
		});
		expect(report.catalog.find((p) => p.id === "anthropic")?.enabled).toBe(false);
		expect(report.issues).toEqual([
			expect.objectContaining({
				severity: "warning",
				path: ["agentEngines", "acp", "gemini"],
				source: { kind: "enforced", label: ENFORCED },
			}),
		]);
	});

	it("keeps an enforced master switch when provider recovery drops the rest of its overlay", async () => {
		// The enforced custom entry has no `type` and no layer supplies one, so
		// the provider stack drops the overlay; its engine switch must survive.
		const report = await load({
			enforced: {
				providers: { custom: { gateway: { enabled: false } } },
				agentEngines: { enabled: false },
			},
		});

		expect(report.issues.some((issue) => issue.severity === "error")).toBe(true);
		expect(report.agentEngines).toEqual({ enabled: false });
	});

	it("salvages an unread source's engines without dropping its provider policy", () => {
		// A caller of the pure resolver may pass a source no reader salvaged.
		const report = resolveProviderCatalogReport({
			sources: [
				{
					kind: "enforced",
					label: "admin",
					config: {
						providers: { anthropic: { enabled: false } },
						agentEngines: { enabled: false, maxLiveSessions: 0, acp: { bad: { command: "" } } },
					},
				},
			],
		});

		expect(report.catalog.find((p) => p.id === "anthropic")?.enabled).toBe(false);
		expect(report.agentEngines).toEqual({ enabled: false, acp: {} });
		expect(report.issues).toEqual([
			expect.objectContaining({
				severity: "warning",
				path: ["agentEngines", "maxLiveSessions"],
				source: { kind: "enforced", label: "admin" },
			}),
			expect.objectContaining({ severity: "warning", path: ["agentEngines", "acp", "bad"] }),
		]);
	});

	it("salvages the user file field by field, keeping the siblings of a bad entry", async () => {
		await fixture.writeRawJsonc(
			JSON.stringify({
				providers: { openai: { baseUrl: "https://openai.example.com" } },
				agentEngines: {
					enabled: true,
					maxLiveSessions: 0,
					claude: { enabled: true, unknownField: 1 },
					copilot: { enabled: true },
					typo: {},
					acp: {
						"Bad Id": { command: "x" },
						nocommand: { args: [] },
						good: { command: "good-agent" },
					},
				},
			}),
		);

		const report = await load();

		expect(report.agentEngines).toEqual({
			enabled: true,
			copilot: { enabled: true },
			acp: { good: { command: "good-agent" } },
		});
		expect(report.catalog.find((p) => p.id === "openai")?.connection.baseUrl).toBe(
			"https://openai.example.com",
		);
		expect(report.issues.map((issue) => issue.path)).toEqual([
			["agentEngines", "maxLiveSessions"],
			["agentEngines", "claude"],
			["agentEngines", "typo"],
			["agentEngines", "acp", "Bad Id"],
			["agentEngines", "acp", "nocommand"],
		]);
	});

	it("lets the writer edit a file that carries agentEngines, keeping the block", async () => {
		await fixture.writeTypedConfig({ agentEngines: { codex: { enabled: true } } });

		await mutateProvidersConfig(
			(current) => ({
				...current,
				providers: { anthropic: { enabled: false } },
			}),
			{ configPath: fixture.configPath },
		);

		expect(JSON.parse(await fixture.readRaw())).toEqual({
			agentEngines: { codex: { enabled: true } },
			providers: { anthropic: { enabled: false } },
		});
	});
});
