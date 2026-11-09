/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { createAwsCredentialProvider } from "../../aws-credentials";
import type { AwsCredentials, Logger } from "../../types";
import { listMantleModels } from "../bedrock-mantle-models";

vi.mock("../../aws-credentials", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../aws-credentials")>();
	return {
		...actual,
		createAwsCredentialProvider: vi.fn(actual.createAwsCredentialProvider),
	};
});

const credentials: AwsCredentials = {
	type: "aws-credentials",
	region: "us-east-2",
	accessKeyId: "AKIDEXAMPLE",
	secretAccessKey: "secret",
};

const GATEWAY_MANTLE_BASE = "https://connect.example.com/__gateway__/bedrock-mantle/g1/v1";

const ACCESS_DENIED_BODY = JSON.stringify({
	error: {
		code: "AccessDeniedException",
		message:
			"User: arn:aws:sts::123456789012:assumed-role/r/u is not authorized to perform: bedrock-mantle:ListModels",
	},
});

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

		const ids = await listMantleModels(credentials, logger(), {}, fetchFunction);
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

		await expect(listMantleModels(credentials, log, {}, fetchFunction)).resolves.toBeNull();
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("signature"));
	});

	it("treats a missing listing path as a debug-level empty result", async () => {
		const log = logger();
		const fetchFunction = vi.fn(async () => new Response("not found", { status: 404 }));

		await expect(listMantleModels(credentials, log, {}, fetchFunction)).resolves.toEqual([]);
		expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("404"));
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("treats a permission-shaped 401 as debug but still warns for auth rejection", async () => {
		const permissionLog = logger();
		await expect(
			listMantleModels(
				credentials,
				permissionLog,
				{},
				vi.fn(async () => new Response("Access denied for ListModels", { status: 401 })),
			),
		).resolves.toEqual([]);
		expect(permissionLog.debug).toHaveBeenCalledWith(expect.stringContaining("ListModels"));
		expect(permissionLog.warn).not.toHaveBeenCalled();

		const authLog = logger();
		await expect(
			listMantleModels(
				credentials,
				authLog,
				{},
				vi.fn(
					async () =>
						new Response("The security token included in the request is expired", {
							status: 401,
						}),
				),
			),
		).resolves.toBeNull();
		expect(authLog.warn).toHaveBeenCalledWith(expect.stringContaining("security token"));
	});

	it("returns null for malformed success bodies", async () => {
		const log = logger();
		const fetchFunction = vi.fn(async () => new Response("{", { status: 200 }));

		await expect(listMantleModels(credentials, log, {}, fetchFunction)).resolves.toBeNull();
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("malformed JSON"));
	});

	it.each([
		["an unrecognized 401", new Response("Unauthorized", { status: 401 })],
		["a service failure", new Response("Service Unavailable", { status: 503 })],
		["an unexpected body", new Response(JSON.stringify({ models: [] }), { status: 200 })],
	])("returns null for %s so the listing is retried", async (_case, response) => {
		await expect(
			listMantleModels(
				credentials,
				logger(),
				{},
				vi.fn(async () => response),
			),
		).resolves.toBeNull();
	});

	it("returns null without a request when credential resolution fails", async () => {
		vi.mocked(createAwsCredentialProvider).mockReturnValueOnce(async () => {
			throw new Error("Token is expired. To refresh this SSO session run 'aws sso login'.");
		});
		const log = logger();
		const fetchFunction = vi.fn(async () => new Response("{}", { status: 200 }));

		await expect(listMantleModels(credentials, log, {}, fetchFunction)).resolves.toBeNull();
		expect(fetchFunction).not.toHaveBeenCalled();
		expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("Token is expired"));
	});

	describe("through a gateway", () => {
		it("lists from the gateway base, signed for bedrock-mantle in the credentials' region", async () => {
			const fetchFunction = vi.fn(
				async (_input: RequestInfo | URL, _init?: RequestInit) =>
					new Response(JSON.stringify({ data: [{ id: "openai.gpt-oss-120b-1:0" }] }), {
						status: 200,
					}),
			);

			const ids = await listMantleModels(
				{ ...credentials, region: "us-west-2" },
				logger(),
				{ baseUrl: `${GATEWAY_MANTLE_BASE}/` },
				fetchFunction,
			);

			expect(ids).toEqual([{ id: "openai.gpt-oss-120b-1:0" }]);
			expect(String(fetchFunction.mock.calls[0][0])).toBe(`${GATEWAY_MANTLE_BASE}/models`);
			const authorization = new Headers(fetchFunction.mock.calls[0][1]?.headers).get(
				"authorization",
			);
			expect(authorization).toContain("/us-west-2/bedrock-mantle/aws4_request");
		});

		it("warns once, naming bedrock-mantle:ListModels, when the listing is denied", async () => {
			const log = logger();
			await expect(
				listMantleModels(
					credentials,
					log,
					{ baseUrl: GATEWAY_MANTLE_BASE },
					vi.fn(async () => new Response(ACCESS_DENIED_BODY, { status: 403 })),
				),
			).resolves.toEqual([]);

			expect(log.warn).toHaveBeenCalledTimes(1);
			expect(log.warn).toHaveBeenCalledWith(
				expect.stringContaining("needs bedrock-mantle:ListModels"),
			);
		});

		it("keeps the direct listing's denied handling at debug", async () => {
			const log = logger();
			await listMantleModels(
				credentials,
				log,
				{},
				vi.fn(async () => new Response(ACCESS_DENIED_BODY, { status: 403 })),
			);

			expect(log.warn).not.toHaveBeenCalled();
			expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("ListModels may be missing"));
		});

		it("keeps signature rejections as a generic failure warning", async () => {
			const log = logger();
			await expect(
				listMantleModels(
					credentials,
					log,
					{ baseUrl: GATEWAY_MANTLE_BASE },
					vi.fn(
						async () =>
							new Response("The request signature we calculated does not match", { status: 403 }),
					),
				),
			).resolves.toBeNull();

			expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("failed (403)"));
			expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining("needs"));
		});

		it("rejects on abort instead of returning null", async () => {
			const controller = new AbortController();
			const fetchFunction = vi.fn(
				(_input: RequestInfo | URL, init?: RequestInit) =>
					new Promise<Response>((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
					}),
			);

			const listing = listMantleModels(
				credentials,
				logger(),
				{ baseUrl: GATEWAY_MANTLE_BASE, signal: controller.signal },
				fetchFunction,
			);
			await vi.waitFor(() => expect(fetchFunction).toHaveBeenCalledTimes(1));
			controller.abort(new Error("cancelled"));

			await expect(listing).rejects.toThrow("cancelled");
		});

		it("makes no request when already aborted", async () => {
			const controller = new AbortController();
			controller.abort(new Error("cancelled"));
			const fetchFunction = vi.fn(async () => new Response("{}", { status: 200 }));

			await expect(
				listMantleModels(
					credentials,
					logger(),
					{ baseUrl: GATEWAY_MANTLE_BASE, signal: controller.signal },
					fetchFunction,
				),
			).rejects.toThrow("cancelled");
			expect(fetchFunction).not.toHaveBeenCalled();
		});
	});
});
