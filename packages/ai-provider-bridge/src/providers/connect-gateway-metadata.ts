/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ChatRequestMetadata } from "../model-clients/ModelClient";

/** Request-scoped key/value attribution fields for gateway clients. */
export type GatewayMetadata = Readonly<Record<string, string>>;

/** Header Posit Connect's LLM gateway reads (and strips before the provider). */
export const GATEWAY_METADATA_HEADER = "Posit-Connect-Gateway-Metadata";

export const GATEWAY_METADATA_LIMITS = {
	maxEntries: 16,
	maxUserEntries: 8,
	maxValueEncodedBytes: 512,
	maxHeaderBytes: 4096,
} as const;

/** Keys only Workbench sets, in send-priority order, with their variables. */
export const WORKBENCH_METADATA_ENV = [
	["workbench-session-id", "PWB_SESSION_ID"],
	["workbench-session-name", "PWB_SESSION_NAME"],
	["workbench-project-name", "PWB_PROJECT_NAME"],
	["workbench-project-path", "PWB_PROJECT_PATH"],
] as const;

/** User fields may not use this prefix; Workbench values cannot be overridden through them. */
export const WORKBENCH_KEY_PREFIX = "workbench-";

/** One user field per variable: POSIT_GATEWAY_META_<KEY>=<value>. */
export const GATEWAY_META_ENV_PREFIX = "POSIT_GATEWAY_META_";

const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;
// Unicode category Cc, matching Go's unicode.IsControl on the Connect side.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f-\u009f]/;

export interface GatewayMetadataRejection {
	readonly key: string;
	readonly reason: string; // e.g. "longer than 512 encoded bytes"
}

/**
 * Encode metadata as the header value. Invalid entries, and entries past a
 * limit, are dropped (never truncated) and reported; blank values count as
 * absent and are not reported.
 */
export function encodeGatewayMetadata(metadata: GatewayMetadata | undefined): {
	header: string | undefined;
	rejected: GatewayMetadataRejection[];
} {
	const rejected: GatewayMetadataRejection[] = [];
	if (!metadata) return { header: undefined, rejected };

	// Workbench keys first (priority order), then every other key sorted.
	const workbenchKeys: string[] = WORKBENCH_METADATA_ENV.map(([key]) => key as string).filter(
		(key) => Object.hasOwn(metadata, key),
	);
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
			// URIError: lone surrogate.
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

/**
 * Read metadata from a process environment: POSIT_GATEWAY_META_<KEY> user
 * fields (key lowercased, `_` → `-`, since nginx drops header names with
 * `_`), then the Workbench values from WORKBENCH_METADATA_ENV. `warnings`
 * describes every dropped value, for the host to log once.
 */
export function gatewayMetadataFromEnv(env: Readonly<Record<string, string | undefined>>): {
	metadata: GatewayMetadata | undefined;
	warnings: string[];
} {
	const warnings: string[] = [];
	const envNameByKey = new Map<string, string>();
	const collisions = new Map<string, string[]>();
	const userValues = new Map<string, string>();

	// Sort env names so results never depend on iteration order.
	const names = Object.keys(env)
		.filter((name) => name.startsWith(GATEWAY_META_ENV_PREFIX))
		.sort();
	for (const envName of names) {
		const value = env[envName];
		if (value === undefined) continue;
		const suffix = envName.slice(GATEWAY_META_ENV_PREFIX.length);
		if (suffix === "") {
			warnings.push(`Ignoring ${envName}: no field name after the prefix`);
			continue;
		}
		const key = suffix.toLowerCase().replace(/_/g, "-");
		if (key.startsWith(WORKBENCH_KEY_PREFIX)) {
			warnings.push(`Ignoring ${envName}: workbench- keys are reserved for Posit Workbench`);
			continue;
		}
		const previous = envNameByKey.get(key);
		if (previous !== undefined) {
			const list = collisions.get(key) ?? [previous];
			list.push(envName);
			collisions.set(key, list);
			continue;
		}
		envNameByKey.set(key, envName);
		userValues.set(key, value);
	}
	for (const [key, list] of collisions) {
		userValues.delete(key);
		envNameByKey.delete(key);
		warnings.push(`Ignoring ${list.join(" and ")}: both name the field "${key}"`);
	}

	// Workbench fields have priority when checking the combined header size.
	const metadata: Record<string, string> = {};
	for (const [key, envName] of WORKBENCH_METADATA_ENV) {
		const value = env[envName];
		if (value) metadata[key] = value;
	}

	let userCount = 0;
	for (const key of [...userValues.keys()].sort()) {
		const envName = envNameByKey.get(key)!;
		const value = userValues.get(key)!;
		// Validate before counting: blank or rejected fields must not use a user slot.
		const { header, rejected } = encodeGatewayMetadata({ [key]: value });
		for (const { reason } of rejected) warnings.push(`Ignoring ${envName}: ${reason}`);
		if (header === undefined) continue;
		const combined = encodeGatewayMetadata({ ...metadata, [key]: value });
		const overflow = combined.rejected.find((entry) => entry.key === key);
		if (overflow) {
			warnings.push(`Ignoring ${envName}: ${overflow.reason}`);
			continue;
		}
		if (userCount >= GATEWAY_METADATA_LIMITS.maxUserEntries) {
			warnings.push(
				`Ignoring ${envName}: more than ${GATEWAY_METADATA_LIMITS.maxUserEntries} user fields`,
			);
			continue;
		}
		metadata[key] = value;
		userCount++;
	}

	for (const { key, reason } of encodeGatewayMetadata(metadata).rejected) {
		const workbench = WORKBENCH_METADATA_ENV.find(([k]) => k === key);
		const envName = workbench ? workbench[1] : (envNameByKey.get(key) ?? key);
		warnings.push(`Ignoring ${envName}: ${reason}`);
		delete metadata[key];
	}
	return { metadata: Object.keys(metadata).length > 0 ? metadata : undefined, warnings };
}

/** Merge gatewayMetadata into request metadata; returns metadata unchanged when it is undefined. */
export function withGatewayMetadata(
	metadata: ChatRequestMetadata | undefined,
	gatewayMetadata: GatewayMetadata | undefined,
): ChatRequestMetadata | undefined {
	if (gatewayMetadata === undefined) return metadata;
	return { ...metadata, gatewayMetadata };
}
