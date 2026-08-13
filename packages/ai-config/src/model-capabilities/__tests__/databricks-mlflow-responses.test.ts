/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import {
	inferDatabricksModelProfile,
	type DatabricksServedEntityInput,
	type DatabricksSurface,
} from "../databricks-helpers.js";

/**
 * The gateway's unified MLflow Responses API is the preferred route for
 * endpoints that do not qualify for a native vendor protocol: chat completions
 * rejects `store` and `max_completion_tokens` and cannot represent the block
 * arrays these models stream for reasoning, while Responses handles all three.
 *
 * Eligibility is the advertised `mlflow/v1/responses` api_type, and the route
 * exists only on the gateway surface.
 */
function entity(apiTypes: readonly string[]): DatabricksServedEntityInput {
	return {
		foundation_model: {
			name: "system.ai.some-model",
			api_types: apiTypes,
			ai_gateway_v2_supported: true,
		},
	};
}

function profile(surface: DatabricksSurface, entities: readonly DatabricksServedEntityInput[]) {
	const result = inferDatabricksModelProfile({
		surface,
		endpointName: "databricks-some-model",
		servedEntities: entities,
	});
	return result.excluded ? "excluded" : result.protocol;
}

const CHAT = "mlflow/v1/chat/completions";
const RESPONSES = "mlflow/v1/responses";

describe("inferDatabricksModelProfile — unified MLflow Responses route", () => {
	it("prefers Responses over chat when the gateway advertises it", () => {
		expect(profile("gateway", [entity([CHAT, RESPONSES])])).toBe("mlflow-responses");
	});

	it("uses Responses when Chat Completions is not advertised", () => {
		expect(profile("gateway", [entity([RESPONSES])])).toBe("mlflow-responses");
	});

	it("falls back to chat when Responses is not advertised", () => {
		expect(profile("gateway", [entity([CHAT])])).toBe("openai-chat");
	});

	it("stays on chat for the serving surface, which has no unified Responses route", () => {
		expect(profile("serving", [entity([CHAT, RESPONSES])])).toBe("openai-chat");
	});

	it("requires every configured entity to advertise Responses", () => {
		expect(profile("gateway", [entity([CHAT, RESPONSES]), entity([CHAT])])).toBe("openai-chat");
	});

	it("does not displace a native vendor protocol", () => {
		const claude: DatabricksServedEntityInput = {
			foundation_model: {
				name: "system.ai.databricks-claude-sonnet-4-5",
				api_types: [CHAT, "anthropic/v1/messages", RESPONSES],
				ai_gateway_v2_supported: true,
			},
		};
		expect(profile("gateway", [claude])).toBe("anthropic-messages");
	});
});
