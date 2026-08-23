/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { LMStudioClient } from "../../model-clients/LMStudioClient";
import type { ModelClientChatParams } from "../../model-clients/ModelClient";
import type { CancellationToken } from "../../types";

function createMockCancellationToken(): CancellationToken {
	return {
		isCancellationRequested: false,
		onCancellationRequested: () => ({ dispose: () => {} }),
	};
}

describe("LMStudioClient protocol guard", () => {
	it("rejects openai-responses protocol", async () => {
		const client = new LMStudioClient("http://localhost:1234/v1");

		const params: ModelClientChatParams = {
			model: "some-model",
			messages: [],
			cancellationToken: createMockCancellationToken(),
			protocol: "openai-responses",
		};

		await expect(client.chat(params)).rejects.toThrow(
			/Unsupported protocol for LM Studio.*openai-responses/,
		);
	});

	it("rejects anthropic-messages protocol", async () => {
		const client = new LMStudioClient("http://localhost:1234/v1");

		const params: ModelClientChatParams = {
			model: "some-model",
			messages: [],
			cancellationToken: createMockCancellationToken(),
			protocol: "anthropic-messages",
		};

		await expect(client.chat(params)).rejects.toThrow(
			/Unsupported protocol for LM Studio.*anthropic-messages/,
		);
	});
});
