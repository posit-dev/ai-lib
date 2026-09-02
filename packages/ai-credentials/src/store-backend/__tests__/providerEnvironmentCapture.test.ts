/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { captureProviderEnvironment } from "../providerEnvMappings.js";

describe("captureProviderEnvironment", () => {
	it("derives names statically and captures only the selected providers' environment", () => {
		const captured = captureProviderEnvironment(["anthropic", "bedrock", "anthropic"], {
			ANTHROPIC_API_KEY: "anthropic-secret",
			AWS_ACCESS_KEY_ID: "access-key",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
			AWS_REGION: "us-east-2",
			UNRELATED_SECRET: "must-not-be-captured",
		});

		expect(captured.declaredNames).toEqual([
			"ANTHROPIC_API_KEY",
			"AWS_ACCESS_KEY_ID",
			"AWS_PROFILE",
			"AWS_REGION",
			"AWS_SECRET_ACCESS_KEY",
			"AWS_SESSION_TOKEN",
		]);
		expect(captured.environment).toEqual({
			ANTHROPIC_API_KEY: "anthropic-secret",
			AWS_ACCESS_KEY_ID: "access-key",
			AWS_PROFILE: undefined,
			AWS_REGION: "us-east-2",
			AWS_SECRET_ACCESS_KEY: "aws-secret",
			AWS_SESSION_TOKEN: undefined,
		});
		expect(captured.environment).not.toHaveProperty("UNRELATED_SECRET");
		expect(Object.isFrozen(captured.declaredNames)).toBe(true);
		expect(Object.isFrozen(captured.environment)).toBe(true);
	});

	it("ignores custom and unknown provider ids without guessing their client kind", () => {
		expect(
			captureProviderEnvironment(["custom:corp", "unknown"], { OPENAI_API_KEY: "secret" }),
		).toEqual({ declaredNames: [], environment: {} });
	});
});
