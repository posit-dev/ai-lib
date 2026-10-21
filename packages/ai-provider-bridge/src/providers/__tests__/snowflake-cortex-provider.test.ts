/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { SNOWFLAKE_CORTEX_CATALOG } from "ai-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ApiKeyCredentials, Logger } from "../../types";
import { ProviderRegistry } from "../ProviderRegistry";
import { registerSnowflakeCortexProvider } from "../snowflake-cortex-provider";

const mockLogger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

describe("registerSnowflakeCortexProvider", () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new ProviderRegistry(mockLogger);
		registerSnowflakeCortexProvider(registry, mockLogger);
	});

	it("returns no models when the Snowflake account URL is missing", async () => {
		const models = await registry.getModelsForProvider("snowflake-cortex", {
			type: "apikey",
			apiKey: "snowflake-token",
		});

		expect(models).toEqual([]);
	});

	it("returns no models for the wrong credential type", async () => {
		const models = await registry.getModelsForProvider("snowflake-cortex", {
			type: "oauth",
			accessToken: "snowflake-token",
		});

		expect(models).toEqual([]);
	});
});

const BASE_URL = "https://acct.snowflakecomputing.com";
const FALLBACK_IDS = [...SNOWFLAKE_CORTEX_CATALOG];

const apiKeyCredentials: ApiKeyCredentials = {
	type: "apikey",
	apiKey: "pat-token",
	baseUrl: BASE_URL,
};

type ShowModelsRow = [name: string, status: string | null];

/**
 * A SQL API v2 result for `SHOW CORTEX BASE MODELS`: uppercase names and a status.
 */
function showModelsResponse(rows: ShowModelsRow[]): Response {
	return new Response(
		JSON.stringify({
			resultSetMetaData: {
				rowType: [{ name: "name" }, { name: "lifecycle_status" }],
			},
			data: rows,
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("Snowflake model discovery via the SQL API", () => {
	let registry: ProviderRegistry;
	let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

	function respondWith(...responses: Array<() => Response>): void {
		for (const response of responses) fetchMock.mockImplementationOnce(async () => response());
	}

	async function discoveredIds(credentials: ApiKeyCredentials = apiKeyCredentials) {
		const models = await registry.getModelsForProvider("snowflake-cortex", credentials);
		return models.map((model) => model.id);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		registry = new ProviderRegistry(mockLogger);
		registerSnowflakeCortexProvider(registry, mockLogger);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("lists recognized models in SQL result order, with display names, under the provider id", async () => {
		respondWith(() =>
			showModelsResponse([
				["OPENAI-GPT-5.4", "GA"],
				["CLAUDE-OPUS-5", "GA"],
				["LLAMA4-MAVERICK", "GA"],
				["OPENAI-1P-GPT-5.6-SOL", "GA"],
				["OPENAI-GPT-6.1-SOL", "PUPR"],
				["CLAUDE-OPUS-4-8", null],
			]),
		);

		const models = await registry.getModelsForProvider("snowflake-cortex", apiKeyCredentials);

		expect(models.map(({ id, name, providerId }) => ({ id, name, providerId }))).toEqual([
			{ id: "openai-gpt-5.4", name: "GPT-5.4", providerId: "snowflake-cortex" },
			{ id: "claude-opus-5", name: "Claude Opus 5", providerId: "snowflake-cortex" },
			{ id: "openai-gpt-6.1-sol", name: "GPT-6.1 Sol", providerId: "snowflake-cortex" },
			{ id: "claude-opus-4-8", name: "Claude Opus 4.8", providerId: "snowflake-cortex" },
		]);
	});

	it.each(["EOL", "LEGACY", "INTERNAL"])(
		"excludes models whose lifecycle status is %s",
		async (status) => {
			respondWith(() =>
				showModelsResponse([
					["CLAUDE-OPUS-5", "GA"],
					["CLAUDE-OPUS-4-8", status],
				]),
			);

			expect(await discoveredIds()).toEqual(["claude-opus-5"]);
		},
	);

	it("falls back to the static list when nothing is listable (cold cache)", async () => {
		respondWith(() =>
			showModelsResponse([
				["MISTRAL-LARGE2", "GA"],
				["CLAUDE-OPUS-5", "EOL"],
			]),
		);
		expect(await discoveredIds()).toEqual(FALLBACK_IDS);
	});

	it.each([
		["an HTTP error", () => new Response("denied", { status: 403 })],
		[
			"a 202 async-execution response",
			() =>
				new Response(
					JSON.stringify({
						code: "333334",
						message:
							"Asynchronous execution in progress. Use provided query id to perform query monitoring and management.",
						statementHandle: "01b5-handle",
						statementStatusUrl: "/api/v2/statements/01b5-handle",
					}),
					{ status: 202 },
				),
		],
		["a non-JSON body", () => new Response("<html>oops</html>", { status: 200 })],
		[
			"a result without name/lifecycle_status columns",
			() =>
				new Response(
					JSON.stringify({ resultSetMetaData: { rowType: [{ name: "other" }] }, data: [["x"]] }),
					{ status: 200 },
				),
		],
	])("falls back to the static list on %s", async (_label, response) => {
		respondWith(response);

		expect(await discoveredIds()).toEqual(FALLBACK_IDS);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("posts the qualified SHOW statement to /api/v2/statements on the base URL origin", async () => {
		respondWith(() => showModelsResponse([["CLAUDE-OPUS-5", "GA"]]));

		await discoveredIds({ ...apiKeyCredentials, baseUrl: `${BASE_URL}/api/v2/cortex/v1` });

		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe(`${BASE_URL}/api/v2/statements`);
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			statement: "SHOW CORTEX BASE MODELS IN SCHEMA SNOWFLAKE.MODELS",
		});
	});

	it("sends Bearer auth for token credentials", async () => {
		respondWith(() => showModelsResponse([["CLAUDE-OPUS-5", "GA"]]));

		await discoveredIds();

		expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe(
			"Bearer pat-token",
		);
	});

	it("sends `Snowflake Token=` auth for session credentials and keeps custom headers", async () => {
		respondWith(() => showModelsResponse([["CLAUDE-OPUS-5", "GA"]]));

		await discoveredIds({
			...apiKeyCredentials,
			apiKey: "session-token",
			snowflake: { sessionConnectionIdentity: "dev" },
			customHeaders: { "X-Gateway": "keep-me" },
		});

		const headers = new Headers(fetchMock.mock.calls[0][1]?.headers);
		expect(headers.get("authorization")).toBe('Snowflake Token="session-token"');
		expect(headers.get("x-gateway")).toBe("keep-me");
	});
});
