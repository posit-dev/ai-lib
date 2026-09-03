/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import {
	captureProviderEnvironment,
	PROVIDER_ENV_MAPPINGS,
	readSdkCredentialEnvironment,
	type SdkCredentialEnvironment,
} from "../providerEnvMappings.js";

describe("captureProviderEnvironment", () => {
	it("captures only the selected providers' environment, deduplicated and frozen", () => {
		const captured = captureProviderEnvironment(["anthropic", "bedrock", "anthropic"], {
			ANTHROPIC_API_KEY: "anthropic-secret",
			AWS_ACCESS_KEY_ID: "access-key",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
			AWS_REGION: "us-east-2",
			UNRELATED_SECRET: "must-not-be-captured",
		});

		// Dedupe: anthropic was requested twice.
		expect(captured.declaredNames.filter((name) => name === "ANTHROPIC_API_KEY")).toHaveLength(1);
		// Exclusion: unrelated names are neither declared nor captured.
		expect(captured.declaredNames).not.toContain("UNRELATED_SECRET");
		expect(captured.environment).not.toHaveProperty("UNRELATED_SECRET");
		// Representative membership: set values arrive, declared-but-unset
		// names are present as undefined.
		expect(captured.environment.ANTHROPIC_API_KEY).toBe("anthropic-secret");
		expect(captured.environment.AWS_REGION).toBe("us-east-2");
		expect(captured.environment).toHaveProperty("AWS_SESSION_TOKEN", undefined);
		// Immutability.
		expect(Object.isFrozen(captured.declaredNames)).toBe(true);
		expect(Object.isFrozen(captured.scrubbedNames)).toBe(true);
		expect(Object.isFrozen(captured.environment)).toBe(true);
	});

	it("partitions scrubbed names from capture-only names", () => {
		const captured = captureProviderEnvironment(["ms-foundry"], {
			AZURE_TENANT_ID: "tenant",
			AZURE_CLIENT_ID: "client",
			AZURE_CLIENT_SECRET: "secret",
		});

		// Representative scrub membership: secrets and the provider API key.
		expect(captured.scrubbedNames).toContain("AZURE_CLIENT_SECRET");
		expect(captured.scrubbedNames).toContain("MS_FOUNDRY_API_KEY");
		// Capture-only membership: non-secret support values are declared and
		// captured, but not offered for scrubbing.
		expect(captured.declaredNames).toContain("AZURE_TENANT_ID");
		expect(captured.declaredNames).toContain("AZURE_CLIENT_ID");
		expect(captured.scrubbedNames).not.toContain("AZURE_TENANT_ID");
		expect(captured.scrubbedNames).not.toContain("AZURE_CLIENT_ID");
		expect(captured.environment.AZURE_TENANT_ID).toBe("tenant");
		expect(captured.environment.AZURE_CLIENT_ID).toBe("client");
	});

	it("ignores custom and unknown provider ids without guessing their client kind", () => {
		expect(
			captureProviderEnvironment(["custom:corp", "unknown"], { OPENAI_API_KEY: "secret" }),
		).toEqual({ declaredNames: [], scrubbedNames: [], environment: {} });
	});

	it("captures every Databricks M2M input from the backend's declaration", () => {
		const captured = captureProviderEnvironment(["databricks"], {
			DATABRICKS_AUTH_TYPE: "oauth-m2m",
			DATABRICKS_HOST: "https://workspace.example.com",
			DATABRICKS_CLIENT_ID: "client-id",
			DATABRICKS_CLIENT_SECRET: "client-secret",
			DATABRICKS_TOKEN: "unused-pat",
		});

		expect(captured.declaredNames).toEqual(
			expect.arrayContaining([
				"DATABRICKS_AUTH_TYPE",
				"DATABRICKS_CLIENT_ID",
				"DATABRICKS_CLIENT_SECRET",
				"DATABRICKS_HOST",
				"DATABRICKS_TOKEN",
			]),
		);
		expect(captured.environment.DATABRICKS_CLIENT_SECRET).toBe("client-secret");
	});

	it("captures every field a complete lazy SDK credential path needs", () => {
		const env = {
			GOOGLE_APPLICATION_CREDENTIALS: "/creds/adc.json",
			AZURE_TENANT_ID: "tenant",
			AZURE_CLIENT_ID: "client",
			AZURE_CLIENT_SECRET: "secret",
			AZURE_CLIENT_CERTIFICATE_PATH: "/certs/az.pem",
			AZURE_CLIENT_CERTIFICATE_PASSWORD: "cert-password",
		};
		const captured = captureProviderEnvironment(["google-vertex", "ms-foundry"], env);

		expect(captured.environment).toMatchObject(env);
		// The reader reconstructs the full typed struct from the capture.
		expect(readSdkCredentialEnvironment(captured.environment)).toEqual({
			googleApplicationCredentials: "/creds/adc.json",
			azureTenantId: "tenant",
			azureClientId: "client",
			azureClientSecret: "secret",
			azureClientCertificatePath: "/certs/az.pem",
			azureClientCertificatePassword: "cert-password",
		});
	});
});

describe("readSdkCredentialEnvironment", () => {
	it("returns a value for every declared SDK semantic key", () => {
		// Exhaustiveness: a descriptor added to any provider mapping without
		// reader support fails here.
		let declaredKeys = 0;
		for (const mapping of Object.values(PROVIDER_ENV_MAPPINGS)) {
			for (const [semanticKey, descriptor] of Object.entries(
				mapping.sdkCredentialEnvironment ?? {},
			)) {
				declaredKeys += 1;
				const result = readSdkCredentialEnvironment({
					[descriptor.name]: `value-for-${descriptor.name}`,
				});
				expect(result[semanticKey as keyof SdkCredentialEnvironment]).toBe(
					`value-for-${descriptor.name}`,
				);
			}
		}
		expect(declaredKeys).toBeGreaterThan(0);
	});

	it("returns undefined fields when the environment lacks them", () => {
		expect(readSdkCredentialEnvironment({})).toEqual({
			googleApplicationCredentials: undefined,
			azureTenantId: undefined,
			azureClientId: undefined,
			azureClientSecret: undefined,
			azureClientCertificatePath: undefined,
			azureClientCertificatePassword: undefined,
		});
	});
});
