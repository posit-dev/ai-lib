/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { hasEnvCredentials, resolveCredentialsFromEnv } from "../envCredentialResolver.js";

describe("resolveCredentialsFromEnv", () => {
	it.each([
		["anthropic", "ANTHROPIC_API_KEY", "sk-ant-test123"],
		["openai", "OPENAI_API_KEY", "sk-openai-test"],
		["gemini", "GEMINI_API_KEY", "gemini-key-123"],
		["openrouter", "OPENROUTER_API_KEY", "openrouter-key"],
		["openai-compatible", "OPENAI_COMPATIBLE_API_KEY", "compat-key"],
		["ms-foundry", "MS_FOUNDRY_API_KEY", "foundry-key"],
		["snowflake-cortex", "SNOWFLAKE_TOKEN", "snowflake-token"],
		["deepseek", "DEEPSEEK_API_KEY", "deepseek-key"],
		["databricks", "DATABRICKS_TOKEN", "databricks-token"],
		["litellm", "LITELLM_API_KEY", "litellm-key"],
		["portkey", "PORTKEY_API_KEY", "portkey-key"],
	] as const)("resolves the %s API key mapping", (providerId, envName, apiKey) => {
		expect(resolveCredentialsFromEnv(providerId, { [envName]: apiKey })).toEqual({
			type: "apikey",
			apiKey,
		});
	});

	it.each([
		["openai", "OPENAI_API_KEY", "OPENAI_BASE_URL"],
		["deepseek", "DEEPSEEK_API_KEY", "DEEPSEEK_BASE_URL"],
		["openai-compatible", "OPENAI_COMPATIBLE_API_KEY", "OPENAI_COMPATIBLE_BASE_URL"],
	] as const)(
		"does not include non-secret connection config in %s credentials",
		(providerId, keyName, baseUrlName) => {
			expect(
				resolveCredentialsFromEnv(providerId, {
					[keyName]: "secret",
					[baseUrlName]: "https://gateway.example.com",
				}),
			).toEqual({ type: "apikey", apiKey: "secret" });
		},
	);

	it("returns null when a mapped API key is not set", () => {
		expect(resolveCredentialsFromEnv("anthropic", {})).toBeNull();
	});

	it("returns null for an unknown provider", () => {
		expect(resolveCredentialsFromEnv("nonexistent-provider", { SOME_KEY: "value" })).toBeNull();
	});

	it("resolves complete AWS credentials with connection config", () => {
		expect(
			resolveCredentialsFromEnv("bedrock", {
				AWS_ACCESS_KEY_ID: "AKIA123",
				AWS_SECRET_ACCESS_KEY: "secret456",
				AWS_REGION: "us-west-2",
				AWS_PROFILE: "dev",
			}),
		).toEqual({
			type: "aws-credentials",
			region: "us-west-2",
			profile: "dev",
			accessKeyId: "AKIA123",
			secretAccessKey: "secret456",
			sessionToken: undefined,
		});
	});

	it("includes an AWS session token", () => {
		expect(
			resolveCredentialsFromEnv("bedrock", {
				AWS_ACCESS_KEY_ID: "AKIA123",
				AWS_SECRET_ACCESS_KEY: "secret456",
				AWS_SESSION_TOKEN: "token789",
				AWS_REGION: "eu-west-1",
			}),
		).toEqual({
			type: "aws-credentials",
			region: "eu-west-1",
			profile: undefined,
			accessKeyId: "AKIA123",
			secretAccessKey: "secret456",
			sessionToken: "token789",
		});
	});

	it.each([
		["region", { AWS_REGION: "us-east-1" }],
		["profile", { AWS_PROFILE: "dev" }],
	] as const)("returns null when AWS has only non-secret %s config", (_name, env) => {
		expect(resolveCredentialsFromEnv("bedrock", env)).toBeNull();
	});

	it("defaults the AWS region when secret credentials are present", () => {
		expect(
			resolveCredentialsFromEnv("bedrock", {
				AWS_ACCESS_KEY_ID: "AKIA123",
				AWS_SECRET_ACCESS_KEY: "secret456",
			}),
		).toMatchObject({ type: "aws-credentials", region: "us-east-1" });
	});

	it.each([
		[
			"positai",
			{ POSITAI_BASE_URL: "https://gateway.posit.ai", POSITAI_AUTH_HOST: "login.posit.cloud" },
		],
		["ollama", { OLLAMA_ENDPOINT: "http://localhost:11434" }],
		["lmstudio", { LMSTUDIO_ENDPOINT: "http://localhost:1234/v1" }],
		["google-vertex", { GOOGLE_CLOUD_PROJECT: "my-project", GOOGLE_CLOUD_LOCATION: "us-central1" }],
	] as const)("returns null for %s non-secret environment config", (providerId, env) => {
		expect(resolveCredentialsFromEnv(providerId, env)).toBeNull();
	});
});

describe("hasEnvCredentials", () => {
	it("returns true when an API key is set", () => {
		expect(hasEnvCredentials("anthropic", { ANTHROPIC_API_KEY: "key" })).toBe(true);
	});

	it("returns false when an API key is not set", () => {
		expect(hasEnvCredentials("anthropic", {})).toBe(false);
	});

	it("returns true for AWS with complete secret credentials", () => {
		expect(
			hasEnvCredentials("bedrock", {
				AWS_ACCESS_KEY_ID: "AKIA",
				AWS_SECRET_ACCESS_KEY: "secret",
			}),
		).toBe(true);
	});

	it("returns false for AWS with only non-secret connection config", () => {
		expect(hasEnvCredentials("bedrock", { AWS_REGION: "us-east-1" })).toBe(false);
	});

	it("returns false for an unknown provider", () => {
		expect(hasEnvCredentials("nonexistent", { SOME_KEY: "value" })).toBe(false);
	});

	it("returns false for an OAuth provider", () => {
		expect(hasEnvCredentials("positai", { POSITAI_BASE_URL: "url" })).toBe(false);
	});
});
