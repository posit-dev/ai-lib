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
const CATALOG_IDS = SNOWFLAKE_CORTEX_CATALOG.map((entry) => entry.id);
const [ACCESSIBLE_A, ACCESSIBLE_B, INACCESSIBLE] = CATALOG_IDS;

const apiKeyCredentials: ApiKeyCredentials = {
	type: "apikey",
	apiKey: "pat-token",
	baseUrl: BASE_URL,
};

/** A SQL API v2 result for `SHOW CORTEX BASE MODELS`: uppercase names, one status each. */
function showModelsResponse(rows: Array<[name: string, status: string | null]>): Response {
	return new Response(
		JSON.stringify({
			resultSetMetaData: {
				rowType: [{ name: "created_on" }, { name: "name" }, { name: "lifecycle_status" }],
			},
			data: rows.map(([name, status]) => ["1", name, status]),
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

	it("narrows the catalog to the models the account can access", async () => {
		respondWith(() =>
			showModelsResponse([
				[ACCESSIBLE_A.toUpperCase(), "GA"],
				["SOME-NON-CATALOG-MODEL", "GA"],
				[ACCESSIBLE_B.toUpperCase(), null],
			]),
		);

		const models = await registry.getModelsForProvider("snowflake-cortex", apiKeyCredentials);

		expect(models.map((model) => model.id)).toEqual(
			CATALOG_IDS.filter((id) => id === ACCESSIBLE_A || id === ACCESSIBLE_B),
		);
		expect(models.every((model) => model.providerId === "snowflake-cortex")).toBe(true);
	});

	it("excludes models whose lifecycle status is EOL", async () => {
		respondWith(() =>
			showModelsResponse([
				[ACCESSIBLE_A.toUpperCase(), "GA"],
				[ACCESSIBLE_B.toUpperCase(), "EOL"],
			]),
		);

		expect(await discoveredIds()).toEqual([ACCESSIBLE_A]);
	});

	it("falls back to the full catalog when no catalog model is accessible (cold cache)", async () => {
		respondWith(() => showModelsResponse([["SOME-NON-CATALOG-MODEL", "GA"]]));
		expect(await discoveredIds()).toEqual(CATALOG_IDS);
	});

	it("falls back to the full catalog when every catalog match is EOL", async () => {
		respondWith(() => showModelsResponse([[ACCESSIBLE_A.toUpperCase(), "EOL"]]));
		expect(await discoveredIds()).toEqual(CATALOG_IDS);
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
	])("falls back to the full catalog on %s", async (_label, response) => {
		respondWith(response);

		expect(await discoveredIds()).toEqual(CATALOG_IDS);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("posts the qualified SHOW statement to /api/v2/statements on the base URL origin", async () => {
		respondWith(() => showModelsResponse([[ACCESSIBLE_A.toUpperCase(), "GA"]]));

		await discoveredIds({ ...apiKeyCredentials, baseUrl: `${BASE_URL}/api/v2/cortex/v1` });

		const [url, init] = fetchMock.mock.calls[0];
		expect(String(url)).toBe(`${BASE_URL}/api/v2/statements`);
		expect(init?.method).toBe("POST");
		expect(JSON.parse(String(init?.body))).toMatchObject({
			statement: "SHOW CORTEX BASE MODELS IN SCHEMA SNOWFLAKE.MODELS",
		});
	});

	it("sends Bearer auth for token credentials", async () => {
		respondWith(() => showModelsResponse([[ACCESSIBLE_A.toUpperCase(), "GA"]]));

		await discoveredIds();

		expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get("authorization")).toBe(
			"Bearer pat-token",
		);
	});

	it("sends `Snowflake Token=` auth for session credentials and keeps custom headers", async () => {
		respondWith(() => showModelsResponse([[ACCESSIBLE_A.toUpperCase(), "GA"]]));

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
