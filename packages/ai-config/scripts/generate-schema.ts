#!/usr/bin/env node

/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Generate providers.schema.json from the Zod schema.
 *
 * Produces a JSON Schema file at the package root (source-controlled) that
 * is also copied into ~/.posit/genai/ alongside providers.json at seed time
 * so editors can validate and autocomplete the config file.
 *
 * Usage: npx tsx scripts/generate-schema.ts
 */

import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";

import * as z from "zod/v4";

import { providersConfigSchema } from "../src/schema";

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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function generateSchema() {
	console.log("🔧 Generating providers.schema.json from Zod schema...");

	try {
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

		const outputPath = path.resolve(__dirname, "../providers.schema.json");

		await fs.writeFile(
			outputPath,
			JSON.stringify(sortKeysDeep(schemaWithMetadata), null, 2) + "\n",
			"utf-8",
		);

		console.log(`✅ providers.schema.json generated: ${outputPath}`);
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

export { generateSchema };
