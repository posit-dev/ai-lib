/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
	createAwsCredentialProvider,
	listMantleModels,
	listFoundationModels,
	listInferenceProfiles,
	resolveBedrockTransport,
	bedrockListClient,
} = vi.hoisted(() => ({
	createAwsCredentialProvider: vi.fn(),
	listMantleModels: vi.fn(),
	listFoundationModels: vi.fn(),
	listInferenceProfiles: vi.fn(),
	resolveBedrockTransport: vi.fn(),
	bedrockListClient: vi.fn(function () {
		return {
			send: (command: { __kind?: string }) =>
				command.__kind === "inference-profiles"
					? listInferenceProfiles(command)
					: listFoundationModels(command),
		};
	}),
}));

vi.mock("../bedrock-mantle-models", () => ({ listMantleModels }));
vi.mock("../../aws-credentials", () => ({ createAwsCredentialProvider }));
vi.mock("../bedrock-transport", () => ({ resolveBedrockTransport }));
vi.mock("@aws-sdk/client-bedrock", () => ({
	BedrockClient: bedrockListClient,
	ListFoundationModelsCommand: vi.fn(function (this: { __kind: string }) {
		this.__kind = "foundation-models";
	}),
	ListInferenceProfilesCommand: vi.fn(function (this: { __kind: string }) {
		this.__kind = "inference-profiles";
	}),
}));

import { mintCustomProviderId } from "ai-config";

import type { Logger } from "../../types";
import {
	checkAwsSignIn,
	registerBedrockProvider,
	registerCustomBedrockProvider,
} from "../bedrock-provider";
import { ProviderRegistry } from "../ProviderRegistry";

function logger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
}

const CLAUDE_MODEL_ID = "anthropic.claude-3-5-sonnet-20241022-v2:0";

function inferenceProfile(profileId: string, modelId: string) {
	return {
		inferenceProfileName: profileId,
		inferenceProfileArn: `arn:aws:bedrock:us-east-1::inference-profile/${profileId}`,
		inferenceProfileId: profileId,
		status: "ACTIVE",
		models: [{ modelArn: `arn:aws:bedrock:us-east-1::foundation-model/${modelId}` }],
		type: "SYSTEM_DEFINED",
	};
}

function credentialsFor(region: string) {
	return {
		type: "aws-credentials" as const,
		region,
		accessKeyId: "key",
		secretAccessKey: "secret",
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	createAwsCredentialProvider.mockReturnValue(async () => ({
		accessKeyId: "key",
		secretAccessKey: "secret",
	}));
	resolveBedrockTransport.mockResolvedValue({
		useFipsEndpoint: false,
		runtimeBaseUrl: "https://bedrock-runtime.us-east-2.amazonaws.com",
		mantleEnabled: true,
	});
	listMantleModels.mockResolvedValue([
		{ id: "openai.gpt-oss-120b" },
		{ id: "openai.gpt-5.6-terra" },
		{ id: "openai.gpt-oss-safeguard-120b" },
		{ id: "openai.unknown-model" },
	]);
	listFoundationModels.mockResolvedValue({
		modelSummaries: [
			{
				modelId: CLAUDE_MODEL_ID,
				modelName: "Claude 3.5 Sonnet",
				responseStreamingSupported: true,
			},
			{
				// The Converse catalog can contain OpenAI IDs, but Mantle owns
				// them and must emit the exact non-prefixed inference ID once.
				modelId: "openai.gpt-oss-120b",
				modelName: "GPT OSS",
				responseStreamingSupported: true,
			},
		],
	});
	// Default: discovery succeeds and mirrors the legacy prefix-constructed ID.
	listInferenceProfiles.mockResolvedValue({
		inferenceProfileSummaries: [inferenceProfile(`us.${CLAUDE_MODEL_ID}`, CLAUDE_MODEL_ID)],
	});
});

describe("Bedrock provider Mantle aggregation", () => {
	it("registers custom AWS discovery under the custom ID and routes chat via bedrock", async () => {
		const registry = new ProviderRegistry(logger());
		const providerId = mintCustomProviderId("custom-bedrock");
		registerCustomBedrockProvider(registry, providerId, logger());
		const credentials = credentialsFor("us-east-2");

		const models = await registry.getModelsForProvider(providerId, credentials);
		expect(models).not.toHaveLength(0);
		expect(models.every((model) => model.providerId === providerId)).toBe(true);
		expect(registry.getClientForProviderOrKind(providerId, credentials, "aws")).not.toBeNull();
	});

	it("attributes custom AWS credential failures to the custom provider", async () => {
		createAwsCredentialProvider.mockReturnValueOnce(async () => {
			throw new Error("credentials unavailable");
		});
		const registry = new ProviderRegistry(logger());
		const providerId = mintCustomProviderId("custom-bedrock");
		const onProviderStatusChange = vi.fn(async () => {});
		registerCustomBedrockProvider(registry, providerId, logger(), { onProviderStatusChange });

		await registry.getModelsForProvider(providerId, {
			type: "aws-credentials",
			region: "us-east-2",
			accessKeyId: "expired",
			secretAccessKey: "expired",
		});

		expect(onProviderStatusChange).toHaveBeenCalledWith(
			expect.objectContaining({ providerId, status: "auth_error" }),
		);
	});

	it("shares a FIPS policy with listing and suppresses Mantle discovery", async () => {
		resolveBedrockTransport.mockResolvedValueOnce({
			useFipsEndpoint: true,
			runtimeBaseUrl: "https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com",
			mantleEnabled: false,
		});
		const registry = new ProviderRegistry(logger());
		registerBedrockProvider(registry, logger());

		await registry.getModelsForProvider("bedrock", credentialsFor("us-gov-west-1"));

		expect(resolveBedrockTransport).toHaveBeenCalledTimes(1);
		expect(listMantleModels).not.toHaveBeenCalled();
		expect(bedrockListClient).toHaveBeenCalledWith(
			expect.objectContaining({
				region: "us-gov-west-1",
				useFipsEndpoint: true,
			}),
		);
	});

	it("maps supported Mantle families, filters duplicates, and caches sources independently", async () => {
		const registry = new ProviderRegistry(logger());
		registerBedrockProvider(registry, logger());
		const credentials = credentialsFor("us-east-2");

		const models = await registry.getModelsForProvider("bedrock", credentials);
		const gptOss = models.find((model) => model.id === "openai.gpt-oss-120b");
		const gpt5 = models.find((model) => model.id === "openai.gpt-5.6-terra");

		expect(gptOss).toMatchObject({
			protocol: "openai-chat",
			baseUrl: "https://bedrock-mantle.us-east-2.api.aws/v1",
		});
		expect(gpt5).toMatchObject({
			protocol: "openai-responses",
			baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
			supportsToolResultImages: true,
			maxContextLength: 1_000_000,
			maxInputTokens: 128_000,
			maxOutputTokens: 16_384,
			capabilityFacts: {
				maxContextLength: 1_000_000,
				maxInputTokens: undefined,
				maxOutputTokens: undefined,
			},
		});
		expect(models.some((model) => model.id.includes("safeguard"))).toBe(false);
		expect(models.some((model) => model.id === "openai.unknown-model")).toBe(false);
		expect(models.some((model) => model.id === "us.openai.gpt-oss-120b")).toBe(false);

		await registry.getModelsForProvider("bedrock", credentials);
		expect(listMantleModels).toHaveBeenCalledTimes(1);
		expect(listFoundationModels).toHaveBeenCalledTimes(1);
	});

	it.each(["openai.gpt-6.1-sol", "openai.gpt-6.1-sol-2026-09-29"])(
		"discovers %s on Responses without the unsupported off level",
		async (id) => {
			listMantleModels.mockResolvedValueOnce([{ id }]);
			const registry = new ProviderRegistry(logger());
			registerBedrockProvider(registry, logger());

			const models = await registry.getModelsForProvider("bedrock", credentialsFor("us-east-2"));

			expect(models.find((model) => model.id === id)).toMatchObject({
				protocol: "openai-responses",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
				thinkingEffortLevels: ["low", "medium", "high", "xhigh", "max"],
				maxContextLength: 1_000_000,
				capabilityFacts: {
					maxContextLength: 1_000_000,
					maxInputTokens: undefined,
					maxOutputTokens: 131_072,
				},
			});
		},
	);

	it("keeps Converse models when Mantle discovery returns no models", async () => {
		listMantleModels.mockResolvedValueOnce([]);
		const registry = new ProviderRegistry(logger());
		const onProviderStatusChange = vi.fn(async () => {});
		registerBedrockProvider(registry, logger(), { onProviderStatusChange });

		const models = await registry.getModelsForProvider("bedrock", credentialsFor("us-east-2"));

		expect(models.some((model) => model.vendor === "anthropic")).toBe(true);
		expect(onProviderStatusChange).toHaveBeenCalledWith(expect.objectContaining({ status: "ok" }));
		expect(onProviderStatusChange).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "auth_error" }),
		);
	});

	it("starts independently stale discovery sources concurrently", async () => {
		let resolveMantle: ((value: Array<{ id: string }>) => void) | undefined;
		let resolveConverse: ((value: { modelSummaries: [] }) => void) | undefined;
		listMantleModels.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveMantle = resolve;
			}),
		);
		listFoundationModels.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveConverse = resolve;
			}),
		);
		const registry = new ProviderRegistry(logger());
		registerBedrockProvider(registry, logger());

		const fetchPromise = registry.getModelsForProvider("bedrock", credentialsFor("us-east-2"));

		await vi.waitFor(() => {
			expect(listMantleModels).toHaveBeenCalledTimes(1);
			expect(listFoundationModels).toHaveBeenCalledTimes(1);
		});
		resolveMantle?.([]);
		resolveConverse?.({ modelSummaries: [] });
		await expect(fetchPromise).resolves.toEqual([]);
	});
});

describe("Bedrock inference profile discovery", () => {
	it("uses discovered profile IDs over prefix construction", async () => {
		listInferenceProfiles.mockResolvedValueOnce({
			inferenceProfileSummaries: [inferenceProfile(`global.${CLAUDE_MODEL_ID}`, CLAUDE_MODEL_ID)],
		});
		const registry = new ProviderRegistry(logger());
		registerBedrockProvider(registry, logger());

		const models = await registry.getModelsForProvider("bedrock", credentialsFor("us-east-1"));

		expect(models.some((model) => model.id === `global.${CLAUDE_MODEL_ID}`)).toBe(true);
		expect(models.some((model) => model.id === `us.${CLAUDE_MODEL_ID}`)).toBe(false);
	});

	it.each([
		["us-east-1", "us"],
		["eu-west-1", "eu"],
		["ap-northeast-1", "apac"],
		["us-gov-west-1", "us-gov"],
	])("falls back to an invokable profile ID in %s", async (region, expectedPrefix) => {
		// Behavior-preservation contract: a denied/failed discovery in a handled
		// family must produce exactly today's IDs.
		listInferenceProfiles.mockRejectedValueOnce(
			Object.assign(new Error("denied"), {
				name: "AccessDeniedException",
				$metadata: { httpStatusCode: 403 },
			}),
		);
		const registry = new ProviderRegistry(logger());
		registerBedrockProvider(registry, logger());

		const models = await registry.getModelsForProvider("bedrock", credentialsFor(region));

		expect(models.some((model) => model.id === `${expectedPrefix}.${CLAUDE_MODEL_ID}`)).toBe(true);
	});

	it("does not fabricate a fallback ID for a foundation model without an ID", async () => {
		listMantleModels.mockResolvedValueOnce([]);
		listFoundationModels.mockResolvedValueOnce({
			modelSummaries: [
				{
					modelName: "Missing model ID",
					responseStreamingSupported: true,
				},
			],
		});
		listInferenceProfiles.mockRejectedValueOnce(
			Object.assign(new Error("denied"), {
				name: "AccessDeniedException",
				$metadata: { httpStatusCode: 403 },
			}),
		);
		const registry = new ProviderRegistry(logger());
		const onProviderStatusChange = vi.fn(async () => {});
		registerBedrockProvider(registry, logger(), { onProviderStatusChange });

		const models = await registry.getModelsForProvider("bedrock", credentialsFor("us-east-1"));

		expect(models).toEqual([]);
		expect(onProviderStatusChange).toHaveBeenCalledWith(expect.objectContaining({ status: "ok" }));
		expect(onProviderStatusChange).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "network_error" }),
		);
	});

	it("returns no Converse models when discovery is unavailable in an unhandled family", async () => {
		listInferenceProfiles.mockRejectedValueOnce(
			Object.assign(new Error("denied"), {
				name: "AccessDeniedException",
				$metadata: { httpStatusCode: 403 },
			}),
		);
		const registry = new ProviderRegistry(logger());
		const onProviderStatusChange = vi.fn(async () => {});
		registerBedrockProvider(registry, logger(), { onProviderStatusChange });

		const models = await registry.getModelsForProvider("bedrock", credentialsFor("ca-central-1"));

		// No fabricated `us.` IDs — and a discovery 403 is a degradation, not
		// an auth failure.
		expect(models.some((model) => model.id.includes(CLAUDE_MODEL_ID))).toBe(false);
		expect(onProviderStatusChange).not.toHaveBeenCalledWith(
			expect.objectContaining({ status: "auth_error" }),
		);
	});

	it("skips FM models absent from a successful profile map", async () => {
		// A successful listing is authoritative absence: guessing an ID for a
		// missing profile would fail at invoke time.
		listInferenceProfiles.mockResolvedValueOnce({ inferenceProfileSummaries: [] });
		const registry = new ProviderRegistry(logger());
		registerBedrockProvider(registry, logger());

		const models = await registry.getModelsForProvider("bedrock", credentialsFor("us-east-1"));

		expect(models.some((model) => model.id.includes(CLAUDE_MODEL_ID))).toBe(false);
	});
});

const SSO_TOKEN_EXPIRED =
	"Token is expired. To refresh this SSO session run 'aws sso login' with the corresponding profile.";
const SSO_PROFILE = { type: "aws-credentials" as const, region: "us-east-1", profile: "sso" };

function chainFailsWith(message: string): void {
	createAwsCredentialProvider.mockReturnValue(() => Promise.reject(new Error(message)));
}

describe("Bedrock credential resolution failures", () => {
	// A configured SSO profile: before classification, any resolution failure on one was
	// reported as sso_expired.
	let configDir: string;
	beforeEach(() => {
		configDir = mkdtempSync(join(tmpdir(), "bedrock-sso-"));
		const configFile = join(configDir, "config");
		writeFileSync(configFile, "[profile sso]\nsso_session = corp\nregion = us-east-1\n");
		vi.stubEnv("AWS_CONFIG_FILE", configFile);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(configDir, { recursive: true, force: true });
	});

	it.each([
		["SDK sign-in wording", SSO_TOKEN_EXPIRED, "sso_expired"],
		["an offline SSO profile", "getaddrinfo ENOTFOUND oidc.us-east-1.amazonaws.com", "auth_error"],
		[
			"helper output mentioning an expired token",
			"Command failed: corp-aws-helper\nerror: OAuth token is expired",
			"auth_error",
		],
	])("model list classifies %s", async (_case, message, code) => {
		chainFailsWith(message);
		const registry = new ProviderRegistry(logger());
		const onProviderStatusChange = vi.fn(async () => {});
		registerBedrockProvider(registry, logger(), { onProviderStatusChange });

		await registry.getModelsForProvider("bedrock", SSO_PROFILE);

		expect(onProviderStatusChange).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "auth_error",
				error: expect.objectContaining({ code }),
			}),
		);
		expect(onProviderStatusChange).not.toHaveBeenCalledWith(
			expect.objectContaining({ userInitiated: true }),
		);
	});
});

describe("checkAwsSignIn", () => {
	it("is ok when the credentials resolve", async () => {
		await expect(checkAwsSignIn("bedrock", SSO_PROFILE, logger())).resolves.toEqual({
			status: "ok",
		});
		expect(createAwsCredentialProvider).toHaveBeenCalledWith(SSO_PROFILE);
	});

	it("requires sign-in on SDK sign-in wording, returning a userInitiated sso_expired update", async () => {
		chainFailsWith(SSO_TOKEN_EXPIRED);

		const result = await checkAwsSignIn("custom-aws", SSO_PROFILE, logger());

		expect(result).toEqual({
			status: "sign-in-required",
			update: expect.objectContaining({
				providerId: "custom-aws",
				authMethodId: "aws-credentials",
				status: "auth_error",
				error: expect.objectContaining({ code: "sso_expired" }),
				userInitiated: true,
			}),
		});
	});

	it("is unknown for an unclassified failure", async () => {
		chainFailsWith("Could not load credentials from any providers");

		await expect(checkAwsSignIn("bedrock", SSO_PROFILE, logger())).resolves.toEqual({
			status: "unknown",
		});
	});
});
