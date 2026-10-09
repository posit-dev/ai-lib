/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/** Header Posit Connect's LLM gateway reads (and strips before the provider). */
export const GATEWAY_METADATA_HEADER = "Posit-Connect-Gateway-Metadata";

/** Workbench passes a JSON object of gateway metadata fields through this variable. */
export const WORKBENCH_GATEWAY_METADATA_ENV = "PWB_CONNECT_GATEWAY_METADATA";

export const GATEWAY_METADATA_LIMITS = {
	maxEntries: 16,
	maxUserEntries: 8,
	maxValueEncodedBytes: 512,
	maxHeaderBytes: 4096,
	maxInputBytes: 16384,
} as const;

/** Workbench fields have priority when the header reaches its size limit. */
const WORKBENCH_KEYS = [
	"workbench-session-id",
	"workbench-session-name",
	"workbench-project-name",
	"workbench-project-path",
] as const;

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Unicode category Cc, matching Go's unicode.IsControl on the Connect side.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export interface GatewayMetadataRejection {
	readonly key: string;
	readonly reason: string;
}

/**
 * Encode fields as Connect's gateway header. Invalid entries, and entries
 * past a limit, are dropped (never truncated). Blank values count as absent.
 */
export function encodeGatewayMetadata(metadata: Readonly<Record<string, string>> | undefined): {
	header: string | undefined;
	rejected: GatewayMetadataRejection[];
} {
	const rejected: GatewayMetadataRejection[] = [];
	if (!metadata) return { header: undefined, rejected };

	const workbenchKeys: string[] = WORKBENCH_KEYS.filter((key) => Object.hasOwn(metadata, key));
	const workbenchSet = new Set<string>(workbenchKeys);
	const otherKeys = Object.keys(metadata)
		.filter((key) => !workbenchSet.has(key))
		.sort();

	const entries: string[] = [];
	let headerLength = 0;
	for (const key of [...workbenchKeys, ...otherKeys]) {
		const value = metadata[key];
		if (!KEY_PATTERN.test(key)) {
			rejected.push({ key, reason: "not 1-32 lowercase letters, digits, or hyphens" });
			continue;
		}
		if (value.trim() === "") continue;
		if (CONTROL_CHARS.test(value)) {
			rejected.push({ key, reason: "contains control characters" });
			continue;
		}
		let encoded: string;
		try {
			encoded = encodeURIComponent(value);
		} catch {
			rejected.push({ key, reason: "is not valid Unicode" });
			continue;
		}
		if (encoded.length > GATEWAY_METADATA_LIMITS.maxValueEncodedBytes) {
			rejected.push({
				key,
				reason: `longer than ${GATEWAY_METADATA_LIMITS.maxValueEncodedBytes} encoded bytes`,
			});
			continue;
		}
		const entry = `${key}=${encoded}`;
		if (entries.length >= GATEWAY_METADATA_LIMITS.maxEntries) {
			rejected.push({ key, reason: `more than ${GATEWAY_METADATA_LIMITS.maxEntries} fields` });
			continue;
		}
		const newLength = headerLength + (entries.length > 0 ? 1 : 0) + entry.length;
		if (newLength > GATEWAY_METADATA_LIMITS.maxHeaderBytes) {
			rejected.push({
				key,
				reason: `header would exceed ${GATEWAY_METADATA_LIMITS.maxHeaderBytes} bytes`,
			});
			continue;
		}
		entries.push(entry);
		headerLength = newLength;
	}
	return { header: entries.length > 0 ? entries.join(",") : undefined, rejected };
}

/** Parse the one Workbench-owned value, accepting only string fields within Connect's limits. */
export function parseWorkbenchGatewayMetadata(value: string | undefined): {
	metadata: Readonly<Record<string, string>> | undefined;
	warnings: string[];
} {
	if (!value) return { metadata: undefined, warnings: [] };
	if (new TextEncoder().encode(value).length > GATEWAY_METADATA_LIMITS.maxInputBytes) {
		return { metadata: undefined, warnings: ["Ignoring oversized Workbench gateway metadata"] };
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return { metadata: undefined, warnings: ["Ignoring malformed Workbench gateway metadata"] };
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return { metadata: undefined, warnings: ["Ignoring non-object Workbench gateway metadata"] };
	}

	const fields: Record<string, unknown> = Object.fromEntries(Object.entries(parsed));
	const input = Object.entries(fields);
	const workbenchSet = new Set<string>(WORKBENCH_KEYS);
	const ordered = [
		...WORKBENCH_KEYS.filter((key) => Object.hasOwn(fields, key)).map(
			(key) => [key, fields[key]] as const,
		),
		...input.filter(([key]) => !workbenchSet.has(key)).sort(([a], [b]) => a.localeCompare(b)),
	];
	const metadata: Record<string, string> = {};
	const warnings: string[] = [];
	let userCount = 0;
	for (const [key, field] of ordered) {
		const label = JSON.stringify(key);
		if (typeof field !== "string") {
			warnings.push(`Ignoring gateway metadata field ${label}: not a string`);
			continue;
		}
		if (key.startsWith("workbench-") && !workbenchSet.has(key)) {
			warnings.push(`Ignoring gateway metadata field ${label}: reserved Workbench key`);
			continue;
		}
		const { header, rejected } = encodeGatewayMetadata({ ...metadata, [key]: field });
		const rejection = rejected.find((entry) => entry.key === key);
		if (rejection) {
			warnings.push(`Ignoring gateway metadata field ${label}: ${rejection.reason}`);
			continue;
		}
		if (!header || field.trim() === "") continue;
		if (!workbenchSet.has(key)) {
			if (userCount >= GATEWAY_METADATA_LIMITS.maxUserEntries) {
				warnings.push(`Ignoring gateway metadata field ${label}: more than 8 user fields`);
				continue;
			}
			userCount++;
		}
		metadata[key] = field;
	}
	return { metadata: Object.keys(metadata).length > 0 ? metadata : undefined, warnings };
}
