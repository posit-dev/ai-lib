/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	NonCustomProviderIdError,
	readUserCustomProviderEntry,
} from "../node/read-user-custom-provider-entry.js";

const temporaryDirectories = new Set<string>();

async function temporaryConfigPath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ai-config-raw-entry-"));
	temporaryDirectories.add(directory);
	return join(directory, "providers.json");
}

afterEach(async () => {
	await Promise.all(
		[...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
	);
	temporaryDirectories.clear();
});

describe("readUserCustomProviderEntry", () => {
	it("returns the exact strict user-layer entry without rewriting its JSONC", async () => {
		const configPath = await temporaryConfigPath();
		const authored = `{
	// This comment and the unrelated provider must remain byte-for-byte intact.
	"version": 1,
	"providers": {
		"custom": {
			"mixed snowflake": {
				"type": "snowflake",
				"baseUrl": "https://private.example/cortex",
				"snowflake": {
					"account": "account-id",
					"host": "account.privatelink.snowflakecomputing.com",
					"home": "/managed/snowflake",
				},
				"customHeaders": { "authorization": "authored-value" },
			},
			"unrelated": { "type": "ollama", "endpoint": "http://localhost:11434" },
		},
	},
}
`;
		await writeFile(configPath, authored);

		await expect(readUserCustomProviderEntry("mixed snowflake", { configPath })).resolves.toEqual({
			type: "snowflake",
			baseUrl: "https://private.example/cortex",
			snowflake: {
				account: "account-id",
				host: "account.privatelink.snowflakecomputing.com",
				home: "/managed/snowflake",
			},
			customHeaders: { authorization: "authored-value" },
		});
		expect(await readFile(configPath, "utf-8")).toBe(authored);
	});

	it("returns undefined for an absent user entry or absent user file", async () => {
		const configPath = await temporaryConfigPath();
		await writeFile(configPath, '{ "version": 1, "providers": { "custom": {} } }');

		await expect(readUserCustomProviderEntry("external gateway", { configPath })).resolves.toBe(
			undefined,
		);
		await expect(
			readUserCustomProviderEntry("external gateway", { configPath: `${configPath}.missing` }),
		).resolves.toBe(undefined);
	});

	it("returns undefined for an absent prototype-named entry", async () => {
		const configPath = await temporaryConfigPath();
		await writeFile(
			configPath,
			'{ "version": 1, "providers": { "custom": { "unrelated": { "type": "ollama" } } } }',
		);

		await expect(readUserCustomProviderEntry("constructor", { configPath })).resolves.toBe(
			undefined,
		);
	});

	it.each(["anthropic", "default", "__proto__"])(
		"rejects non-custom provider id %s with a typed error",
		async (providerId) => {
			await expect(readUserCustomProviderEntry(providerId)).rejects.toBeInstanceOf(
				NonCustomProviderIdError,
			);
		},
	);

	it("rejects invalid user JSONC instead of salvaging it", async () => {
		const configPath = await temporaryConfigPath();
		await writeFile(
			configPath,
			'{ "version": 1, "providers": { "custom": { "gateway": { "type": "aws", "unexpected": true } } } }',
		);

		await expect(readUserCustomProviderEntry("gateway", { configPath })).rejects.toThrow(
			/Fix the file before editing custom providers/,
		);
	});

	it("rejects an unreadable path", async () => {
		const configPath = await temporaryConfigPath();
		await mkdir(configPath);

		await expect(readUserCustomProviderEntry("gateway", { configPath })).rejects.toThrow(
			/Cannot read/,
		);
	});
});
