/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from "vitest";

import {
	POSIT_AI_DEFAULTS,
	OLLAMA_DEFAULTS,
	LMSTUDIO_DEFAULTS,
	BEDROCK_DEFAULTS,
	GOOGLE_VERTEX_DEFAULTS,
	PROVIDER_CONNECTION_DEFAULTS,
} from "../defaults";

describe("provider connection defaults", () => {
	it("POSIT_AI_DEFAULTS has expected shape", () => {
		expect(POSIT_AI_DEFAULTS.baseUrl).toBe("https://gateway.posit.ai");
		expect(POSIT_AI_DEFAULTS.positaiLogin.host).toBe("login.posit.cloud");
		expect(POSIT_AI_DEFAULTS.positaiLogin.clientId).toBe("rstudio-ide");
		expect(POSIT_AI_DEFAULTS.positaiLogin.scope).toBe("prism");
	});

	it("OLLAMA_DEFAULTS has expected endpoint", () => {
		expect(OLLAMA_DEFAULTS.endpoint).toBe("http://localhost:11434");
	});

	it("LMSTUDIO_DEFAULTS has expected endpoint", () => {
		// Bare server root: LMStudioClient appends /v1 itself, so a /v1 suffix
		// here would produce /v1/v1 URLs downstream.
		expect(LMSTUDIO_DEFAULTS.endpoint).toBe("http://localhost:1234");
	});

	it("BEDROCK_DEFAULTS has expected region", () => {
		expect(BEDROCK_DEFAULTS.aws.region).toBe("us-east-1");
	});

	it("GOOGLE_VERTEX_DEFAULTS has expected location", () => {
		expect(GOOGLE_VERTEX_DEFAULTS.googleCloud.location).toBe("us-central1");
	});

	it("PROVIDER_CONNECTION_DEFAULTS maps provider ids to defaults", () => {
		expect(PROVIDER_CONNECTION_DEFAULTS.positai).toBe(POSIT_AI_DEFAULTS);
		expect(PROVIDER_CONNECTION_DEFAULTS.ollama).toBe(OLLAMA_DEFAULTS);
		expect(PROVIDER_CONNECTION_DEFAULTS.lmstudio).toBe(LMSTUDIO_DEFAULTS);
		expect(PROVIDER_CONNECTION_DEFAULTS.bedrock).toBe(BEDROCK_DEFAULTS);
		expect(PROVIDER_CONNECTION_DEFAULTS["google-vertex"]).toBe(GOOGLE_VERTEX_DEFAULTS);
	});

	it("providers without specific defaults are not in the map", () => {
		expect(PROVIDER_CONNECTION_DEFAULTS.anthropic).toBeUndefined();
		expect(PROVIDER_CONNECTION_DEFAULTS.openai).toBeUndefined();
	});
});
