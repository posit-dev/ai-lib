/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { isPlainObject } from "../is-plain-object.js";
import { pruneUnknownKeys } from "../prune-unknown-keys.js";
import {
	builtinProviderBlockSchema,
	customProviderEntryFragmentSchema,
	defaultBlockSchema,
	providersMapFragmentSchema,
} from "../schema.js";

const BASE = ["providers", "anthropic"] as const;

function unrecognized(path: readonly (string | number)[], key: string) {
	return { severity: "warning", path, message: `Unrecognized key: "${key}".` };
}

describe("pruneUnknownKeys", () => {
	it("keeps record data keys: header names, model ids, custom provider names", () => {
		const block = {
			customHeaders: { "X-Tenant": "a", "x-route": "b" },
			models: { overrides: { "claude-opus-4": { name: "Opus" }, "my/model:v2": {} } },
		};
		expect(pruneUnknownKeys(block, builtinProviderBlockSchema, BASE)).toEqual({
			value: block,
			issues: [],
		});

		const custom = { "my-gateway": { type: "openai-compatible", enabled: true } };
		const pruned = pruneUnknownKeys(custom, providersMapFragmentSchema.shape.custom, [
			"providers",
			"custom",
		]);
		expect(pruned).toEqual({ value: custom, issues: [] });
	});

	it.each(["constructor", "toString", "futureField"])(
		"removes an unknown %s key and keeps the rest of the block",
		(key) => {
			const raw = JSON.parse(`{"enabled": false, "${key}": 1}`);
			const pruned = pruneUnknownKeys(raw, builtinProviderBlockSchema, BASE);
			expect(pruned.value).toEqual({ enabled: false });
			expect(pruned.issues).toEqual([unrecognized([...BASE, key], key)]);
			expect(builtinProviderBlockSchema.parse(pruned.value)).toEqual({ enabled: false });
		},
	);

	it("removes unknown keys at depth with their full paths", () => {
		const raw = {
			enabled: true,
			aws: { region: "us-east-1", futureAuth: "sso" },
			models: {
				overrides: { "m-1": { name: "M", futureCap: true } },
				custom: [
					{
						id: "c-1",
						name: "C",
						maxContextLength: 1000,
						supportsTools: true,
						supportsImages: false,
						supportsToolResultImages: false,
						supportsWebSearch: false,
						futureMeta: 1,
					},
				],
			},
			endpoints: { "openai-chat": "https://a.example", "future-protocol": "https://b.example" },
		};
		const pruned = pruneUnknownKeys(raw, builtinProviderBlockSchema, BASE);
		expect(pruned.issues).toEqual([
			unrecognized([...BASE, "aws", "futureAuth"], "futureAuth"),
			unrecognized([...BASE, "models", "overrides", "m-1", "futureCap"], "futureCap"),
			unrecognized([...BASE, "models", "custom", 0, "futureMeta"], "futureMeta"),
			unrecognized([...BASE, "endpoints", "future-protocol"], "future-protocol"),
		]);
		expect(pruned.value).toEqual({
			enabled: true,
			aws: { region: "us-east-1" },
			models: {
				overrides: { "m-1": { name: "M" } },
				custom: [
					{
						id: "c-1",
						name: "C",
						maxContextLength: 1000,
						supportsTools: true,
						supportsImages: false,
						supportsToolResultImages: false,
						supportsWebSearch: false,
					},
				],
			},
			endpoints: { "openai-chat": "https://a.example" },
		});
		expect(builtinProviderBlockSchema.safeParse(pruned.value).success).toBe(true);
	});

	it.each([
		{ name: "array for models", block: { enabled: false, models: [] } },
		{ name: "array for models.overrides", block: { models: { overrides: [] } } },
		{ name: "object for models.custom", block: { models: { custom: {} } } },
		{ name: "null for a sub-section", block: { aws: null } },
	])("passes a wrong container shape through unchanged: $name", ({ block }) => {
		const pruned = pruneUnknownKeys(block, builtinProviderBlockSchema, BASE);
		expect(pruned).toEqual({ value: block, issues: [] });
		expect(builtinProviderBlockSchema.safeParse(pruned.value).success).toBe(false);
	});

	it("leaves enum and union values to validation", () => {
		const entry = { type: "future-kind", protocol: "future-protocol", enabled: true };
		const pruned = pruneUnknownKeys(entry, customProviderEntryFragmentSchema, [
			"providers",
			"custom",
			"gw",
		]);
		expect(pruned).toEqual({ value: entry, issues: [] });
	});

	it("never sets an own __proto__ key as the output's prototype", () => {
		const raw = JSON.parse('{"__proto__": {"enabled": false}, "enabled": true}');
		const pruned = pruneUnknownKeys(raw, defaultBlockSchema, ["providers", "default"]);
		expect(pruned.issues).toEqual([
			unrecognized(["providers", "default", "__proto__"], "__proto__"),
		]);
		expect(pruned.value).toEqual({ enabled: true });
		expect(Object.getPrototypeOf(pruned.value)).toBe(Object.prototype);

		const headers = JSON.parse('{"customHeaders": {"__proto__": "x", "X-Ok": "y"}}');
		const kept = pruneUnknownKeys(headers, builtinProviderBlockSchema, BASE).value;
		if (!isPlainObject(kept) || !isPlainObject(kept.customHeaders)) {
			throw new Error("expected pruned headers object");
		}
		expect(Object.getPrototypeOf(kept.customHeaders)).toBe(Object.prototype);
		expect(Object.keys(kept.customHeaders)).toEqual(["__proto__", "X-Ok"]);
	});
});
