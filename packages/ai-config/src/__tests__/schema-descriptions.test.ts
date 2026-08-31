/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Every user-addressable field in providers.json must carry a `.describe()`.
 *
 * Descriptions are load-bearing twice over: editors show them as hover text for
 * anyone hand-editing `providers.json` against the generated schema, and the
 * Assistant docs site generates its providers.json reference from them.
 *
 * The walker below deliberately throws on any JSON Schema construct it does not
 * explicitly handle. A walker that silently skips an unrecognized construct
 * reports vacuous success, which is the one failure mode this test exists to
 * prevent.
 */

import { describe, it, expect } from "vitest";
import * as z from "zod/v4";

import { providersConfigSchema } from "../schema.js";

/**
 * Keywords that carry no nested schema, so the walker can stop at them.
 * Anything outside this list and {@link RECURSING_KEYWORDS} is unhandled.
 */
const LEAF_KEYWORDS = new Set([
	"$id",
	"$schema",
	"title",
	"description",
	"type",
	"enum",
	"const",
	"required",
	"default",
	"examples",
	"deprecated",
	"format",
	"pattern",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minItems",
	"maxItems",
	"uniqueItems",
]);

const RECURSING_KEYWORDS = new Set([
	"properties",
	"items",
	"additionalProperties",
	"propertyNames",
	"oneOf",
	"anyOf",
	"allOf",
]);

type JsonSchema = boolean | { [keyword: string]: unknown };

/** A named property that the walker reached, with the path a user would write. */
interface DiscoveredField {
	path: string;
	description: string | undefined;
}

/**
 * Walk a JSON Schema and collect every named property under a `properties` map.
 *
 * Structural nodes (record wrappers, array `items`, union branches) are not
 * themselves user-addressable and are exempt from the description contract, but
 * the walker still descends through them so the named properties inside are
 * checked.
 *
 * @throws if the schema uses a construct this walker does not explicitly support.
 */
function collectDescribedFields(root: JsonSchema): DiscoveredField[] {
	const found: DiscoveredField[] = [];

	function visit(node: JsonSchema, path: string): void {
		// `true`/`false` are valid JSON Schemas meaning "anything"/"nothing".
		if (typeof node === "boolean") {
			return;
		}

		for (const keyword of Object.keys(node)) {
			if (LEAF_KEYWORDS.has(keyword)) {
				continue;
			}
			if (!RECURSING_KEYWORDS.has(keyword)) {
				throw new Error(
					`Unsupported JSON Schema construct \`${keyword}\` at ${path || "<root>"}. ` +
						`Teach collectDescribedFields how to traverse it before adding it to the schema.`,
				);
			}
		}

		const properties = node.properties;
		if (properties !== undefined) {
			for (const [name, child] of Object.entries(properties as Record<string, JsonSchema>)) {
				const childPath = path ? `${path}.${name}` : name;
				found.push({
					path: childPath,
					description:
						typeof child === "object" && typeof child.description === "string"
							? child.description
							: undefined,
				});
				visit(child, childPath);
			}
		}

		if (node.items !== undefined) {
			visit(node.items as JsonSchema, `${path}[]`);
		}

		if (node.additionalProperties !== undefined) {
			visit(node.additionalProperties as JsonSchema, `${path}.{key}`);
		}

		if (node.propertyNames !== undefined) {
			visit(node.propertyNames as JsonSchema, `${path}.{keyName}`);
		}

		for (const keyword of ["oneOf", "anyOf", "allOf"] as const) {
			const branches = node[keyword];
			if (branches !== undefined) {
				(branches as JsonSchema[]).forEach((branch, index) => {
					visit(branch, `${path}<${keyword}[${index}]>`);
				});
			}
		}
	}

	visit(root, "");
	return found;
}

describe("collectDescribedFields", () => {
	it("finds properties nested under `properties`", () => {
		const schema = z.toJSONSchema(
			z.object({ outer: z.object({ inner: z.string().describe("INNER") }) }),
		);
		expect(collectDescribedFields(schema)).toContainEqual({
			path: "outer.inner",
			description: "INNER",
		});
	});

	it("descends into array `items`", () => {
		const schema = z.toJSONSchema(
			z.object({ list: z.array(z.object({ field: z.string().describe("FIELD") })) }),
		);
		expect(collectDescribedFields(schema)).toContainEqual({
			path: "list[].field",
			description: "FIELD",
		});
	});

	it("descends into record values via `additionalProperties`", () => {
		const schema = z.toJSONSchema(
			z.object({
				map: z.record(z.string(), z.object({ field: z.string().describe("VALUE") })),
			}),
		);
		expect(collectDescribedFields(schema)).toContainEqual({
			path: "map.{key}.field",
			description: "VALUE",
		});
	});

	it("descends into record keys via `propertyNames`", () => {
		// A record's key schema is structural, so it yields no row and cannot be
		// checked by inspecting the output. Nest an unsupported construct inside
		// it instead: the walker can only reach it by traversing `propertyNames`,
		// so this fails if that branch is ever dropped.
		expect(() =>
			collectDescribedFields({
				type: "object",
				propertyNames: { type: "string", patternProperties: {} },
			}),
		).toThrow(/Unsupported JSON Schema construct `patternProperties`/);
	});

	it("descends into every union branch", () => {
		const schema = z.toJSONSchema(
			z.object({
				choice: z.discriminatedUnion("t", [
					z.object({ t: z.literal("x"), only_x: z.string().describe("ONLY_X") }),
					z.object({ t: z.literal("y"), only_y: z.string().describe("ONLY_Y") }),
				]),
			}),
		);
		const paths = collectDescribedFields(schema).map((f) => f.description);
		expect(paths).toContain("ONLY_X");
		expect(paths).toContain("ONLY_Y");
	});

	it("throws on a construct it does not explicitly support", () => {
		expect(() => collectDescribedFields({ type: "object", patternProperties: {} })).toThrow(
			/Unsupported JSON Schema construct `patternProperties`/,
		);
	});
});

describe("providers.json schema descriptions", () => {
	it("describes every user-addressable field", () => {
		const fields = collectDescribedFields(z.toJSONSchema(providersConfigSchema));

		// Guards the guard: an empty walk would pass the assertion below vacuously.
		expect(fields.length).toBeGreaterThan(0);

		const undescribed = fields.filter((f) => f.description === undefined).map((f) => f.path);
		expect(undescribed).toEqual([]);
	});
});
