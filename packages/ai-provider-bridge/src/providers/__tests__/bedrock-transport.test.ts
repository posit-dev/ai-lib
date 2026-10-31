/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Bedrock model listing goes through the AWS SDK, not `fetch`. Every list
 * client gets this stub transport, which records the host each request reached
 * after the SDK's endpoint middleware ran.
 */
const awsSdk = vi.hoisted(() => {
	interface CapturedAwsRequest {
		hostname: string;
		path: string;
	}
	const requests: CapturedAwsRequest[] = [];
	return {
		requests,
		requestHandler: {
			async handle(request: CapturedAwsRequest) {
				requests.push({ hostname: request.hostname, path: request.path });
				const body = request.path.startsWith("/inference-profiles")
					? { inferenceProfileSummaries: [] }
					: { modelSummaries: [] };
				return {
					response: {
						statusCode: 200,
						headers: { "content-type": "application/json" },
						body: new TextEncoder().encode(JSON.stringify(body)),
					},
				};
			},
		},
	};
});

vi.mock("@aws-sdk/client-bedrock", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@aws-sdk/client-bedrock")>();
	class BedrockClient extends actual.BedrockClient {
		constructor(config: ConstructorParameters<typeof actual.BedrockClient>[0]) {
			super({ ...config, requestHandler: awsSdk.requestHandler });
		}
	}
	return { ...actual, BedrockClient };
});

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import { BedrockClient } from "../../model-clients/BedrockClient";
import type { CancellationToken, Logger } from "../../types";
import { registerBedrockProvider, type BedrockProviderStatusUpdate } from "../bedrock-provider";
import { resolveBedrockTransport, resolveConfiguredBedrockEndpoints } from "../bedrock-transport";
import { ProviderRegistry } from "../ProviderRegistry";

/** Every ambient AWS setting that can change a Bedrock destination or identity. */
const ENVIRONMENT_KEYS = [
	"AWS_CONFIG_FILE",
	"AWS_SHARED_CREDENTIALS_FILE",
	"AWS_PROFILE",
	"AWS_USE_FIPS_ENDPOINT",
	"AWS_USE_DUALSTACK_ENDPOINT",
	"AWS_ENDPOINT_URL",
	"AWS_ENDPOINT_URL_BEDROCK",
	"AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
	"AWS_IGNORE_CONFIGURED_ENDPOINT_URLS",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
] as const;
const originalEnvironment = new Map<string, string | undefined>();
let configDirectory: string;
let configFile: string;
let credentialsFile: string;
let testIndex = 0;

const INITIAL_CONFIG = [
	"[profile standard]",
	"use_fips_endpoint = false",
	"",
	"[profile secure]",
	"use_fips_endpoint = true",
	"",
].join("\n");

function logger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
}

beforeAll(async () => {
	for (const key of ENVIRONMENT_KEYS) {
		originalEnvironment.set(key, process.env[key]);
	}
	configDirectory = await mkdtemp(join(tmpdir(), "bedrock-transport-"));
	credentialsFile = join(configDirectory, "credentials");
});

beforeEach(async () => {
	// A fresh path per test: the AWS SDK caches parsed config by path, which
	// would otherwise let one test's file leak into the next.
	testIndex += 1;
	configFile = join(configDirectory, `config-${testIndex}`);
	for (const key of ENVIRONMENT_KEYS) {
		delete process.env[key];
	}
	process.env.AWS_CONFIG_FILE = configFile;
	process.env.AWS_SHARED_CREDENTIALS_FILE = credentialsFile;
	await writeFile(configFile, INITIAL_CONFIG, "utf8");
	await writeFile(credentialsFile, "", "utf8");
	awsSdk.requests.length = 0;
});

afterEach(() => {
	for (const key of ENVIRONMENT_KEYS) {
		const original = originalEnvironment.get(key);
		if (original === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = original;
		}
	}
	vi.unstubAllGlobals();
});

afterAll(async () => {
	await rm(configDirectory, { recursive: true, force: true });
});

describe("resolveBedrockTransport", () => {
	it("loads use_fips_endpoint from the selected shared-config profile", async () => {
		process.env.AWS_CONFIG_FILE = configFile;
		delete process.env.AWS_USE_FIPS_ENDPOINT;

		await expect(
			resolveBedrockTransport({ region: "us-east-1", profile: "standard" }),
		).resolves.toEqual({
			useFipsEndpoint: false,
			runtimeBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
			mantleEnabled: true,
		});
		await expect(
			resolveBedrockTransport({ region: "us-gov-west-1", profile: "secure" }),
		).resolves.toEqual({
			useFipsEndpoint: true,
			runtimeBaseUrl: "https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com",
			mantleEnabled: false,
		});
	});

	it("lets an explicit false environment value override a true profile", async () => {
		process.env.AWS_CONFIG_FILE = configFile;
		process.env.AWS_USE_FIPS_ENDPOINT = "false";

		await expect(
			resolveBedrockTransport({ region: "us-gov-east-1", profile: "secure" }),
		).resolves.toEqual({
			useFipsEndpoint: false,
			runtimeBaseUrl: "https://bedrock-runtime.us-gov-east-1.amazonaws.com",
			mantleEnabled: true,
		});
	});

	it("observes shared-config edits at the same path between operations", async () => {
		process.env.AWS_CONFIG_FILE = configFile;
		delete process.env.AWS_USE_FIPS_ENDPOINT;

		await expect(
			resolveBedrockTransport({ region: "us-gov-west-1", profile: "secure" }),
		).resolves.toMatchObject({ useFipsEndpoint: true });

		await writeFile(
			configFile,
			["[profile secure]", "use_fips_endpoint = false", ""].join("\n"),
			"utf8",
		);

		await expect(
			resolveBedrockTransport({ region: "us-gov-west-1", profile: "secure" }),
		).resolves.toEqual({
			useFipsEndpoint: false,
			runtimeBaseUrl: "https://bedrock-runtime.us-gov-west-1.amazonaws.com",
			mantleEnabled: true,
		});
	});

	it("lets a true environment value enable FIPS in a commercial region", async () => {
		process.env.AWS_CONFIG_FILE = configFile;
		process.env.AWS_USE_FIPS_ENDPOINT = "true";
		const log = logger();

		await expect(
			resolveBedrockTransport({ region: "us-east-2", profile: "standard", logger: log }),
		).resolves.toEqual({
			useFipsEndpoint: true,
			runtimeBaseUrl: "https://bedrock-runtime-fips.us-east-2.amazonaws.com",
			mantleEnabled: false,
		});
		expect(log.debug).toHaveBeenCalledWith(
			expect.stringContaining(
				"runtimeHost=bedrock-runtime-fips.us-east-2.amazonaws.com, listingHost=bedrock-fips.us-east-2.amazonaws.com",
			),
		);
	});
});

// ---------------------------------------------------------------------------
// Configured endpoints (AWS_ENDPOINT_URL*, endpoint_url) on direct Bedrock
// ---------------------------------------------------------------------------

const REGION = "us-east-1";
const AMAZON_RUNTIME = `https://bedrock-runtime.${REGION}.amazonaws.com`;
const AMAZON_LISTING_HOST = `bedrock.${REGION}.amazonaws.com`;
const GATEWAY = "https://connect.example.com/__gateway__/bedrock/g1";
/** Explicit keys keep credential resolution off the shared files; the profile still selects config. */
const KEYS = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "fake-secret" };

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

async function writeConfig(...lines: string[]): Promise<void> {
	await writeFile(configFile, [...lines, ""].join("\n"), "utf8");
}

function chatClient(): BedrockClient {
	return new BedrockClient({ region: REGION, profile: "standard", ...KEYS }, logger());
}

function chat(client: BedrockClient, baseUrl?: string) {
	return client.chat({
		model: "amazon.nova-pro-v1:0",
		baseUrl,
		messages: [{ role: "user", content: "Hello" }],
		cancellationToken,
	});
}

/** The URL a direct-Bedrock chat request reached. */
async function chatDestination(baseUrl?: string): Promise<string> {
	// An empty event stream: the request is recorded and the chat ends quietly.
	const capture = createRawFetchCapture(
		async () =>
			new Response(new Uint8Array(0), {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			}),
	);
	vi.stubGlobal("fetch", capture.mock);
	for await (const _part of await chat(chatClient(), baseUrl)) {
		// Drain the stream.
	}
	const [input] = capture.call(0);
	return input instanceof Request ? input.url : String(input);
}

/** Run a direct-Bedrock model listing; report the AWS SDK hosts it reached and its statuses. */
async function listModels(): Promise<{ hosts: string[]; statuses: BedrockProviderStatusUpdate[] }> {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(JSON.stringify({ data: [] }), { status: 200 })),
	);
	const statuses: BedrockProviderStatusUpdate[] = [];
	const registry = new ProviderRegistry(logger());
	registerBedrockProvider(registry, logger(), {
		onProviderStatusChange: async (update) => {
			statuses.push(update);
		},
	});
	await registry.getModelsForProvider("bedrock", {
		type: "aws-credentials",
		region: REGION,
		profile: "standard",
		...KEYS,
	});
	return { hosts: [...new Set(awsSdk.requests.map((request) => request.hostname))], statuses };
}

/** Every configured-endpoint source at once, each with a distinct value. */
async function setAllFourSources(...extraProfileLines: string[]): Promise<void> {
	process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = "http://env-runtime.example";
	process.env.AWS_ENDPOINT_URL_BEDROCK = "http://env-listing.example";
	process.env.AWS_ENDPOINT_URL = "http://env-global.example";
	await writeConfig(
		"[profile standard]",
		"services = local",
		"endpoint_url = http://profile.example",
		...extraProfileLines,
		"",
		"[services local]",
		"bedrock_runtime =",
		"  endpoint_url = http://services-runtime.example",
		"bedrock =",
		"  endpoint_url = http://services-listing.example",
	);
}

describe("resolveConfiguredBedrockEndpoints", () => {
	const resolveStandard = () => resolveConfiguredBedrockEndpoints({ profile: "standard" });

	it("prefers the service env var, then AWS_ENDPOINT_URL, then [services], then endpoint_url", async () => {
		await setAllFourSources();
		await expect(resolveStandard()).resolves.toEqual({
			runtime: "http://env-runtime.example",
			listing: "http://env-listing.example",
		});

		delete process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME;
		delete process.env.AWS_ENDPOINT_URL_BEDROCK;
		await expect(resolveStandard()).resolves.toEqual({
			runtime: "http://env-global.example",
			listing: "http://env-global.example",
		});

		delete process.env.AWS_ENDPOINT_URL;
		await expect(resolveStandard()).resolves.toEqual({
			runtime: "http://services-runtime.example",
			listing: "http://services-listing.example",
		});

		await writeConfig("[profile standard]", "endpoint_url = http://profile.example");
		await expect(resolveStandard()).resolves.toEqual({
			runtime: "http://profile.example",
			listing: "http://profile.example",
		});
	});

	it("disables all four sources when switched off in the environment", async () => {
		await setAllFourSources();
		process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";

		await expect(resolveStandard()).resolves.toEqual({ runtime: undefined, listing: undefined });
	});

	it("disables all four sources when switched off in the selected profile", async () => {
		await setAllFourSources("ignore_configured_endpoint_urls = true");

		await expect(resolveStandard()).resolves.toEqual({ runtime: undefined, listing: undefined });
	});

	it("reads the named profile, not the default or AWS_PROFILE's", async () => {
		await writeConfig(
			"[default]",
			"endpoint_url = http://default.example",
			"",
			"[profile other]",
			"endpoint_url = http://other.example",
			"",
			"[profile standard]",
			"endpoint_url = http://standard.example",
			"",
			"[profile bare]",
			"region = us-east-1",
		);
		const standard = { runtime: "http://standard.example", listing: "http://standard.example" };
		const none = { runtime: undefined, listing: undefined };

		await expect(resolveStandard()).resolves.toEqual(standard);
		await expect(resolveConfiguredBedrockEndpoints({ profile: "bare" })).resolves.toEqual(none);

		process.env.AWS_PROFILE = "other";
		await expect(resolveStandard()).resolves.toEqual(standard);
		await expect(resolveConfiguredBedrockEndpoints({ profile: "bare" })).resolves.toEqual(none);
	});
});

describe("configured endpoints on direct Bedrock", () => {
	describe("chat", () => {
		it("sees an edit to endpoint_url at the same path on the next chat", async () => {
			// FIPS from the environment keeps the transport's own lookup off the
			// file, so only the endpoint lookup can observe the edit.
			process.env.AWS_USE_FIPS_ENDPOINT = "false";
			await writeConfig("[profile standard]", "endpoint_url = http://first.example");
			expect(await chatDestination()).toMatch(/^http:\/\/first\.example\//);

			await writeConfig("[profile standard]", "endpoint_url = http://second.example");
			expect(await chatDestination()).toMatch(/^http:\/\/second\.example\//);
		});

		it("refuses a configured endpoint under FIPS", async () => {
			process.env.AWS_USE_FIPS_ENDPOINT = "true";
			process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = "http://local.example";
			const capture = createRawFetchCapture(async () => new Response("{}"));
			vi.stubGlobal("fetch", capture.mock);

			await expect(chat(chatClient())).rejects.toThrow(
				/FIPS and a configured endpoint are not supported together/,
			);
			expect(capture.calls).toHaveLength(0);
		});

		it("honors the off switch from the environment", async () => {
			process.env.AWS_ENDPOINT_URL_BEDROCK_RUNTIME = "http://stale.example";
			process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";

			expect(await chatDestination()).toMatch(new RegExp(`^${AMAZON_RUNTIME}/`));
		});

		it("honors the off switch from the selected profile", async () => {
			process.env.AWS_ENDPOINT_URL = "http://stale.example";
			await writeConfig("[profile standard]", "ignore_configured_endpoint_urls = true");

			expect(await chatDestination()).toMatch(new RegExp(`^${AMAZON_RUNTIME}/`));
		});

		it("lets a Connect gateway base URL win over AWS_ENDPOINT_URL", async () => {
			process.env.AWS_ENDPOINT_URL = "http://local.example:4566";

			expect(await chatDestination(GATEWAY)).toMatch(new RegExp(`^${GATEWAY}/`));
		});
	});

	describe("listing", () => {
		it("reaches Amazon's host when the global endpoint is switched off", async () => {
			process.env.AWS_ENDPOINT_URL = "http://ignored.example:4566";
			process.env.AWS_IGNORE_CONFIGURED_ENDPOINT_URLS = "true";

			expect((await listModels()).hosts).toEqual([AMAZON_LISTING_HOST]);
		});

		it("reaches Amazon's host when the selected profile has no endpoint", async () => {
			await writeConfig(
				"[default]",
				"endpoint_url = http://default-profile.example",
				"",
				"[profile standard]",
				"region = us-east-1",
			);

			expect((await listModels()).hosts).toEqual([AMAZON_LISTING_HOST]);
		});

		it("reaches the selected profile's endpoint", async () => {
			await writeConfig("[profile standard]", "endpoint_url = http://listing.example:4566");

			expect((await listModels()).hosts).toEqual(["listing.example"]);
		});

		it("refuses a configured endpoint under FIPS", async () => {
			process.env.AWS_USE_FIPS_ENDPOINT = "true";
			process.env.AWS_ENDPOINT_URL_BEDROCK = "http://local.example";

			const { hosts, statuses } = await listModels();

			expect(hosts).toEqual([]);
			expect(statuses).toContainEqual(
				expect.objectContaining({
					status: "network_error",
					error: expect.objectContaining({
						message: expect.stringMatching(
							/FIPS and a configured endpoint are not supported together/,
						),
					}),
				}),
			);
		});
	});
});
