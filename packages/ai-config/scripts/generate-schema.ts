#!/usr/bin/env node

/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Generate providers.schema.json from the Zod schema.
 *
 * Produces two source-controlled artifacts, both derived from the same bytes:
 *
 * 1. `providers.schema.json` at the package root — the package export, read by
 *    the Assistant docs generator and by anyone pointing an editor at it.
 * 2. `src/generated/providers-schema-source.ts` — the same content as a string
 *    constant, so `mutateProvidersConfig` can write the schema next to
 *    ~/.posit/ai/providers.json without resolving a file at runtime.
 *
 * The constant exists because consumers bundle ai-config (esbuild inlines it),
 * and no consumer ships a `node_modules/ai-config` directory. A runtime
 * `require.resolve("ai-config/providers.schema.json")` therefore throws in every
 * packaged build, which silently left users with no schema at all. Inlining the
 * bytes is the only form that survives bundling.
 *
 * Usage: npx tsx scripts/generate-schema.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

import * as z from "zod/v4";

import { providersConfigSchema } from "../src/schema.js";

// ---------------------------------------------------------------------------
// Schema post-processing utilities
//
// NOTE: duplicated from @assistant/node (packages/node/src/config/schemaUtils.ts).
// ai-config cannot import @assistant/node; keep in sync manually.
// ---------------------------------------------------------------------------

/**
 * Represents a JSON Schema, which can be either an object or a boolean.
 * In JSON Schema, `true` means "allow anything" and `false` means "allow nothing".
 */
type JSONSchema = JSONSchemaObject | boolean;

/**
 * Represents a JSON Schema object with properties relevant to our processing.
 */
interface JSONSchemaObject {
	type?: string;
	properties?: Record<string, JSONSchema>;
	required?: string[];
	default?: unknown;
	items?: JSONSchema | JSONSchema[];
	additionalProperties?: JSONSchema;
	[key: string]: unknown;
}

/**
 * Recursively sort all object keys alphabetically for deterministic JSON output.
 * Zod's toJSONSchema() doesn't guarantee key ordering, so without this,
 * generated schema files can have non-deterministic diffs between builds.
 *
 * NOTE: duplicated in @assistant/node (packages/node/src/config/schemaUtils.ts).
 * ai-config cannot import @assistant/node; keep in sync manually.
 */
function sortKeysDeep(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(sortKeysDeep);
	}
	if (value !== null && typeof value === "object") {
		const sorted: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			sorted[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
		}
		return sorted;
	}
	return value;
}

/**
 * Remove fields with defaults from required arrays.
 *
 * Zod v4's toJSONSchema() marks fields with .default() as required,
 * but semantically if a field has a default, it shouldn't be required.
 *
 * NOTE: duplicated in @assistant/node (packages/node/src/config/schemaUtils.ts).
 * ai-config cannot import @assistant/node; keep in sync manually.
 */
function removeDefaultFieldsFromRequired(schema: JSONSchema): JSONSchema {
	if (typeof schema === "boolean") {
		return schema;
	}

	const result: JSONSchemaObject = { ...schema };

	// If this object has both 'properties' and 'required', filter the required array
	if (result.properties && result.required && Array.isArray(result.required)) {
		result.required = result.required.filter((fieldName: string) => {
			const field = result.properties?.[fieldName];
			if (typeof field === "boolean" || field === undefined) {
				return true;
			}
			return field.default === undefined;
		});

		if (result.required.length === 0) {
			delete result.required;
		}
	}

	// Recursively process all object properties
	if (result.properties) {
		const processedProperties: Record<string, JSONSchema> = {};
		for (const key of Object.keys(result.properties)) {
			processedProperties[key] = removeDefaultFieldsFromRequired(result.properties[key]);
		}
		result.properties = processedProperties;
	}

	// Process items if it's an array schema
	if (result.items !== undefined) {
		if (Array.isArray(result.items)) {
			result.items = result.items.map((item: JSONSchema) => removeDefaultFieldsFromRequired(item));
		} else {
			result.items = removeDefaultFieldsFromRequired(result.items);
		}
	}

	// Process additionalProperties if it's a schema object
	if (
		result.additionalProperties !== undefined &&
		typeof result.additionalProperties !== "boolean"
	) {
		result.additionalProperties = removeDefaultFieldsFromRequired(result.additionalProperties);
	}

	return result;
}

/**
 * Remove `required` arrays from record-style schemas.
 *
 * Zod v4's `toJSONSchema()` erroneously adds a `required` array to
 * `z.record(enumSchema, valueSchema.optional())` schemas, listing all enum
 * values as required even though the values are optional. Record schemas are
 * identified by having `propertyNames` or `additionalProperties` but no
 * explicit `properties` object.
 *
 * NOTE: duplicated in @assistant/node (packages/node/src/config/schemaUtils.ts).
 * ai-config cannot import @assistant/node; keep in sync manually.
 */
function removeRecordRequiredFields(schema: JSONSchema): JSONSchema {
	if (typeof schema === "boolean") {
		return schema;
	}

	const result: JSONSchemaObject = { ...schema };

	// Record schemas: have propertyNames/additionalProperties but no properties
	if (
		result.required &&
		!result.properties &&
		(result.propertyNames || result.additionalProperties)
	) {
		delete result.required;
	}

	// Recursively process nested schemas
	if (result.properties) {
		const processed: Record<string, JSONSchema> = {};
		for (const key of Object.keys(result.properties)) {
			processed[key] = removeRecordRequiredFields(result.properties[key]);
		}
		result.properties = processed;
	}

	if (result.items !== undefined) {
		if (Array.isArray(result.items)) {
			result.items = result.items.map((item: JSONSchema) => removeRecordRequiredFields(item));
		} else {
			result.items = removeRecordRequiredFields(result.items);
		}
	}

	if (
		result.additionalProperties !== undefined &&
		typeof result.additionalProperties !== "boolean"
	) {
		result.additionalProperties = removeRecordRequiredFields(result.additionalProperties);
	}

	return result;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

const COPYRIGHT_HEADER = `/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/`;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function serializeProvidersSchema(): string {
	const jsonSchema = z.toJSONSchema(providersConfigSchema);

	let cleanedSchema = removeDefaultFieldsFromRequired(jsonSchema);
	cleanedSchema = removeRecordRequiredFields(cleanedSchema);

	const schemaWithMetadata = {
		...cleanedSchema,
		$id: "https://posit.co/schemas/providers.schema.json",
		$schema: "http://json-schema.org/draft-07/schema#",
		title: "Posit AI Provider Configuration",
		description:
			"Configuration file for AI provider connections, enablement, and model overrides. " +
			"See https://github.com/posit-dev/assistant for documentation.",
	};

	return JSON.stringify(sortKeysDeep(schemaWithMetadata), null, 2) + "\n";
}

async function generateSchema() {
	console.log("🔧 Generating providers.schema.json from Zod schema...");

	try {
		const outputPath = path.resolve(__dirname, "../providers.schema.json");
		const contents = serializeProvidersSchema();

		await fs.writeFile(outputPath, contents, "utf-8");

		console.log(`✅ providers.schema.json generated: ${outputPath}`);

		// Stored minified to halve what every consumer bundles (440KB -> 224KB).
		// `JSON.stringify(JSON.parse(minified), null, 2) + "\n"` reproduces
		// `contents` byte for byte, so the written file is identical either way.
		// JSON.stringify of the string yields a fully-escaped JS literal; a
		// template literal would not be safe, since descriptions contain backticks.
		const minified = JSON.stringify(JSON.parse(contents));
		const sourcePath = path.resolve(__dirname, "../src/generated/providers-schema-source.ts");
		const module = [
			COPYRIGHT_HEADER,
			"",
			"/**",
			" * DO NOT EDIT. Generated by scripts/generate-schema.ts.",
			" *",
			" * providers.schema.json, minified and inlined so the schema can be written",
			" * next to providers.json without resolving a file at runtime (which fails in",
			" * bundled consumers \u2014 see the generator's header for why).",
			" */",
			`const MINIFIED = ${JSON.stringify(minified)};`,
			"",
			"let cached: string | undefined;",
			"",
			"/**",
			" * The exact bytes to write as providers.schema.json.",
			" *",
			" * Memoized: the callers check this against a file on every config mutation,",
			" * and re-expanding a 224KB constant into 440KB each time is pure waste. The",
			" * value is fixed at build time, so caching it is unconditionally safe.",
			" */",
			"export function providersSchemaFileContents(): string {",
			'\tcached ??= JSON.stringify(JSON.parse(MINIFIED), null, 2) + "\\n";',
			"\treturn cached;",
			"}",
			"",
		].join("\n");

		await fs.mkdir(path.dirname(sourcePath), { recursive: true });
		await fs.writeFile(sourcePath, module, "utf-8");

		console.log(`✅ providers-schema-source.ts generated: ${sourcePath}`);
	} catch (error) {
		console.error("❌ Failed to generate providers.schema.json:", error);
		process.exit(1);
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	generateSchema().catch((error) => {
		console.error(error);
		process.exit(1);
	});
}

export { generateSchema, serializeProvidersSchema };
