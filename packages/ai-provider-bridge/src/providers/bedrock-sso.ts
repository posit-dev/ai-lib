/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { readFile } from "fs/promises";
import os from "os";
import path from "path";

function normalizeSectionName(rawName: string): string {
	const name = rawName.trim();
	return name.startsWith("profile ") ? name.slice("profile ".length).trim() : name;
}

export function parseAwsConfig(content: string): Map<string, Map<string, string>> {
	const sections = new Map<string, Map<string, string>>();
	let currentSection: Map<string, string> | null = null;

	for (const rawLine of content.split(/\r?\n/u)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#") || line.startsWith(";")) {
			continue;
		}

		const sectionMatch = line.match(/^\[(.+)\]$/u);
		if (sectionMatch) {
			const sectionName = normalizeSectionName(sectionMatch[1]);
			currentSection = new Map<string, string>();
			sections.set(sectionName, currentSection);
			continue;
		}

		if (!currentSection) {
			continue;
		}

		const separatorIndex = line.indexOf("=");
		if (separatorIndex === -1) {
			continue;
		}

		const key = line.slice(0, separatorIndex).trim().toLowerCase();
		const value = line.slice(separatorIndex + 1).trim();
		currentSection.set(key, value);
	}

	return sections;
}

export async function isAwsSsoProfileConfigured(
	profile?: string,
	env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
	const resolvedProfile = profile ?? env.AWS_PROFILE ?? "default";
	const configFilePath = env.AWS_CONFIG_FILE || path.join(os.homedir(), ".aws", "config");

	let content: string;
	try {
		content = await readFile(configFilePath, "utf8");
	} catch {
		return false;
	}

	const profileConfig = parseAwsConfig(content).get(resolvedProfile);
	if (!profileConfig) {
		return false;
	}

	return profileConfig.has("sso_session") || profileConfig.has("sso_start_url");
}
