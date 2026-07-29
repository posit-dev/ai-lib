/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import type { AwsCredentials, Logger } from "../../types";
import { listMantleModels } from "../bedrock-mantle-models";

const credentials: AwsCredentials = {
	type: "aws-credentials",
	region: "us-east-2",
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "secret",
};

function logger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
}

describe("listMantleModels", () => {
	it("signs the one live listing path with bedrock-mantle and filters unavailable entries", async () => {
		const fixturePath = fileURLToPath(
			new URL("./fixtures/bedrock-mantle-models.json", import.meta.url),
		);
		const fixture = JSON.parse(readFileSync(fixturePath, "utf8"));
		fixture.data.push({
			id: "openai.gpt-5.unavailable",
			object: "model",
			status: "unavailable",
			status_reason: "Data retention policy mismatch",
		});
		const fetchFunction = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const authorization = new Headers(init?.headers).get("authorization");
			expect(authorization).toContain("/us-east-2/bedrock-mantle/aws4_request");
			return new Response(JSON.stringify(fixture), { status: 200 });
		});

		const ids = await listMantleModels(credentials, logger(), fetchFunction);
		const modelIds = ids.map(({ id }) => id);

		expect(fetchFunction).toHaveBeenCalledTimes(1);
		expect(String(fetchFunction.mock.calls[0][0])).toBe(
			"https://bedrock-mantle.us-east-2.api.aws/v1/models",
		);
		expect(modelIds).toContain("openai.gpt-oss-120b");
		expect(modelIds).toContain("openai.gpt-5.6-terra");
		expect(modelIds).not.toContain("openai.gpt-5.unavailable");
	});

	it("never throws and logs signature failures with their body", async () => {
		const log = logger();
		const fetchFunction = vi.fn(async () => {
			return new Response("The request signature we calculated does not match", { status: 403 });
		});

		await expect(listMantleModels(credentials, log, fetchFunction)).resolves.toEqual([]);
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("signature"));
	});

	it("treats a missing listing path as a debug-level empty result", async () => {
		const log = logger();
		const fetchFunction = vi.fn(async () => new Response("not found", { status: 404 }));

		await expect(listMantleModels(credentials, log, fetchFunction)).resolves.toEqual([]);
		expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("404"));
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("treats a permission-shaped 401 as debug but still warns for auth rejection", async () => {
		const permissionLog = logger();
		await expect(
			listMantleModels(
				credentials,
				permissionLog,
				vi.fn(async () => new Response("Access denied for ListModels", { status: 401 })),
			),
		).resolves.toEqual([]);
		expect(permissionLog.debug).toHaveBeenCalledWith(expect.stringContaining("ListModels"));
		expect(permissionLog.warn).not.toHaveBeenCalled();

		const authLog = logger();
		await listMantleModels(
			credentials,
			authLog,
			vi.fn(
				async () =>
					new Response("The security token included in the request is expired", { status: 401 }),
			),
		);
		expect(authLog.warn).toHaveBeenCalledWith(expect.stringContaining("security token"));
	});

	it("returns an empty list for malformed success bodies", async () => {
		const log = logger();
		const fetchFunction = vi.fn(async () => new Response("{", { status: 200 }));

		await expect(listMantleModels(credentials, log, fetchFunction)).resolves.toEqual([]);
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("malformed JSON"));
	});
});
