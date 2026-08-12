/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../types";
import { resolveBedrockTransport } from "../bedrock-transport";

const ENVIRONMENT_KEYS = ["AWS_CONFIG_FILE", "AWS_PROFILE", "AWS_USE_FIPS_ENDPOINT"] as const;
const originalEnvironment = new Map<string, string | undefined>();
let configDirectory: string;
let configFile: string;

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
	configFile = join(configDirectory, "config");
});

beforeEach(async () => {
	await writeFile(configFile, INITIAL_CONFIG, "utf8");
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
