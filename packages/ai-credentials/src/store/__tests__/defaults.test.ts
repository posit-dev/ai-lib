/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Module-level variable for mocking homedir.
let mockHome: string | undefined;

vi.mock("os", async (importOriginal) => {
	const original = await importOriginal<typeof os>();
	return { ...original, homedir: () => mockHome ?? original.homedir() };
});

// Import AFTER mocks are registered.
const { getDefaultStorePath, createDefaultStore } = await import("../defaults.js");

describe("getDefaultStorePath", () => {
	let tmpHome: string;

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "default-store-path-test-"));
		mockHome = tmpHome;
	});

	afterEach(async () => {
		mockHome = undefined;
		await fs.rm(tmpHome, { recursive: true, force: true });
	});

	it("returns {home}/.posit/ai/auth/data.json", () => {
		const expected = path.join(tmpHome, ".posit", "ai", "auth", "data.json");
		expect(getDefaultStorePath()).toBe(expected);
	});
});

describe("createDefaultStore", () => {
	let tmpHome: string;

	beforeEach(async () => {
		tmpHome = await fs.mkdtemp(path.join(os.tmpdir(), "default-store-test-"));
		mockHome = tmpHome;
	});

	afterEach(async () => {
		mockHome = undefined;
		await fs.rm(tmpHome, { recursive: true, force: true });
	});

	it("creates a store that writes to the default path", async () => {
		const store = createDefaultStore();
		await store.set("test-key", { value: 42 });

		// Verify the file was written at the expected path
		const expectedPath = path.join(tmpHome, ".posit", "ai", "auth", "data.json");
		const raw = await fs.readFile(expectedPath, "utf-8");
		const data = JSON.parse(raw);
		expect(data["test-key"]).toEqual({ value: 42 });
	});

	it("accepts an optional logger and produces a functional store", async () => {
		const logger = { debug: vi.fn(), warn: vi.fn() };
		const store = createDefaultStore(logger);
		await store.set("x", { n: 1 });

		const result = await store.get<{ n: number }>("x");
		expect(result).toEqual({ n: 1 });
	});
});
