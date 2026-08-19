/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readUserCustomProviderEntries } from "../node/read-user-custom-provider-entries.js";

const temporaryDirectories = new Set<string>();

async function temporaryConfigPath(): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), "ai-config-raw-entries-"));
	temporaryDirectories.add(directory);
	return join(directory, "providers.json");
}

afterEach(async () => {
	await Promise.all(
		[...temporaryDirectories].map((directory) => rm(directory, { recursive: true, force: true })),
	);
	temporaryDirectories.clear();
});

describe("readUserCustomProviderEntries", () => {
	it("returns every user-layer entry in one strict parse", async () => {
		const configPath = await temporaryConfigPath();
		await writeFile(
			configPath,
			`{
	"version": 1,
	"providers": {
		"custom": {
			"mixed snowflake": {
				"type": "snowflake",
				"baseUrl": "https://private.example/cortex",
				"snowflake": { "account": "account-id" },
			},
			"unrelated": { "type": "ollama", "endpoint": "http://localhost:11434" },
		},
	},
}
`,
		);

		const entries = await readUserCustomProviderEntries({ configPath });
		expect(entries.size).toBe(2);
		expect(entries.get("mixed snowflake")).toEqual({
			type: "snowflake",
			baseUrl: "https://private.example/cortex",
			snowflake: { account: "account-id" },
		});
		expect(entries.get("unrelated")).toEqual({
			type: "ollama",
			endpoint: "http://localhost:11434",
		});
	});

	it("returns an empty map for an absent user file or empty custom map", async () => {
		const configPath = await temporaryConfigPath();
		await expect(
			readUserCustomProviderEntries({ configPath: `${configPath}.missing` }),
		).resolves.toEqual(new Map());

		await writeFile(configPath, '{ "version": 1, "providers": { "custom": {} } }');
		await expect(readUserCustomProviderEntries({ configPath })).resolves.toEqual(new Map());
	});

	it("keeps prototype-named keys safe for membership checks", async () => {
		const configPath = await temporaryConfigPath();
		await writeFile(
			configPath,
			'{ "version": 1, "providers": { "custom": { "unrelated": { "type": "ollama" } } } }',
		);

		const entries = await readUserCustomProviderEntries({ configPath });
		expect(entries.has("constructor")).toBe(false);
		expect(entries.has("unrelated")).toBe(true);
	});

	it("rejects invalid user JSONC instead of salvaging it", async () => {
		const configPath = await temporaryConfigPath();
		await writeFile(
			configPath,
			'{ "version": 1, "providers": { "custom": { "gateway": { "type": "aws", "unexpected": true } } } }',
		);

		await expect(readUserCustomProviderEntries({ configPath })).rejects.toThrow(
			/Fix the file before editing custom providers/,
		);
	});

	it("rejects an unreadable path", async () => {
		const configPath = await temporaryConfigPath();
		await mkdir(configPath);

		await expect(readUserCustomProviderEntries({ configPath })).rejects.toThrow(/Cannot read/);
	});
});
