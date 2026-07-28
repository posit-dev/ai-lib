/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { dereferenceJsonSchema, dereferenceToolParameters } from "../tool-schema-deref";

/** The schema zod v4 emits for `z.object({ args: z.array(z.json()).optional() })`. */
const zodJsonSchema = {
	$schema: "http://json-schema.org/draft-07/schema#",
	type: "object",
	properties: {
		args: {
			description: "Positional arguments.",
			type: "array",
			items: { $ref: "#/definitions/__schema0" },
		},
	},
	definitions: {
		__schema0: {
			anyOf: [
				{ type: "string" },
				{ type: "number" },
				{ type: "boolean" },
				{ type: "null" },
				{ type: "array", items: { $ref: "#/definitions/__schema0" } },
				{ type: "object", propertyNames: { type: "string" }, additionalProperties: false },
			],
		},
	},
	additionalProperties: false,
};

describe("dereferenceJsonSchema", () => {
	it("inlines a non-recursive $ref and drops the definitions container", () => {
		const out = dereferenceJsonSchema({
			type: "object",
			properties: { name: { $ref: "#/definitions/str" } },
			definitions: { str: { type: "string", minLength: 1 } },
		});
		expect(out).toEqual({
			type: "object",
			properties: { name: { type: "string", minLength: 1 } },
		});
	});

	it("resolves $defs pointers", () => {
		const out = dereferenceJsonSchema({
			type: "object",
			properties: { name: { $ref: "#/$defs/str" } },
			$defs: { str: { type: "string" } },
		});
		expect(out).toEqual({
			type: "object",
			properties: { name: { type: "string" } },
		});
	});

	it("keeps sibling annotations on the reference node", () => {
		const out = dereferenceJsonSchema({
			properties: { name: { $ref: "#/definitions/str", description: "The name." } },
			definitions: { str: { type: "string" } },
		});
		expect(out).toEqual({
			properties: { name: { type: "string", description: "The name." } },
		});
	});

	it("cuts recursive references to the permissive {} schema", () => {
		const out = dereferenceJsonSchema(zodJsonSchema) as {
			properties: { args: { items: { anyOf: unknown[] } } };
		};
		expect(JSON.stringify(out)).not.toContain("$ref");
		expect(JSON.stringify(out)).not.toContain("definitions");
		// One level of expansion, then the self-reference collapses to {}.
		const anyOf = out.properties.args.items.anyOf;
		expect(anyOf).toContainEqual({ type: "string" });
		expect(anyOf).toContainEqual({ type: "array", items: {} });
	});

	it("replaces external and dangling references with {}", () => {
		const out = dereferenceJsonSchema({
			properties: {
				a: { $ref: "https://example.com/schema.json" },
				b: { $ref: "#/definitions/missing", description: "Kept." },
			},
		});
		expect(out).toEqual({
			properties: { a: {}, b: { description: "Kept." } },
		});
	});

	it("resolves nested pointers and ~0/~1 escapes", () => {
		const out = dereferenceJsonSchema({
			properties: { a: { $ref: "#/definitions/a~1b~0c/inner" } },
			definitions: { "a/b~c": { inner: { type: "number" } } },
		});
		expect(out).toEqual({ properties: { a: { type: "number" } } });
	});
});

describe("dereferenceToolParameters", () => {
	const refTool = {
		type: "function",
		function: { name: "withRef", description: "d", parameters: zodJsonSchema },
	};
	const plainTool = {
		type: "function",
		function: {
			name: "plain",
			description: "d",
			parameters: { type: "object", properties: { x: { type: "string" } } },
		},
	};

	it("dereferences only tools whose schemas contain $ref", () => {
		const body = { model: "m", tools: [plainTool, refTool], tool_choice: "auto" };
		const out = dereferenceToolParameters(body);
		expect(JSON.stringify(out)).not.toContain("$ref");
		const outTools = out.tools as typeof body.tools;
		expect(outTools[0]).toBe(plainTool);
		expect(out.model).toBe("m");
		expect(out.tool_choice).toBe("auto");
	});

	it("returns the body unchanged when no tool schema contains $ref", () => {
		const body = { model: "m", tools: [plainTool] };
		expect(dereferenceToolParameters(body)).toBe(body);
	});

	it("returns the body unchanged when tools are absent", () => {
		const body = { model: "m", messages: [] };
		expect(dereferenceToolParameters(body)).toBe(body);
	});
});
