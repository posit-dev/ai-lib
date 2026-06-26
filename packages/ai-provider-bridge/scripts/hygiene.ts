#!/usr/bin/env node

/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Hygiene check script:
 * Verifies that all source files have proper copyright statements.
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Shebang regex.
const SHEBANG_REGEX = /^#!.*$/;

// Copyright header lines regex patterns.
export const COPYRIGHT_HEADER_LINES_REGEX = [
	/^\/\*-{93}$/,
	/^ \* {2}Copyright \(C\) 20\d{2}(?:-20\d{2})? Posit Software, PBC\. All rights reserved\.$/,
	/^ \*-{92}\*\/$/,
];

// File extensions to check.
const FILE_EXTENSIONS = [".ts", ".tsx", ".js", ".css"];

// Directories to exclude.
const EXCLUDE_DIRS = [
	"node_modules",
	"build",
	"dist",
	"out",
	".vscode",
	".git",
	".husky",
	"memory-bank",
	"venv",
	".venv",
	".astro",
];

// Specific files to exclude (in any directory).
const EXCLUDE_FILES = [
	"vscode-proposed.d.ts", // VS Code proposed API (external).
];

/**
 * Result of the hygiene check.
 */
interface HygieneCheckResult {
	missingCopyright: string[];
	checked: number;
}

/**
 * Check if a file should be excluded.
 */
function shouldExcludeFile(filePath: string): boolean {
	const fileName = path.basename(filePath);
	return EXCLUDE_FILES.includes(fileName);
}

/**
 * Recursively find all files with specified extensions
 * @param dir The directory to search.
 * @param extensions The extensions to include.
 * @returns An array of file paths.
 */
function findFiles(dir: string, extensions: string[]): string[] {
	// Results array.
	const results: string[] = [];

	// Read directory entries and process them.
	const entries = fs.readdirSync(dir);
	for (const entry of entries) {
		// Get the full path of the entry and stat it.
		const fullPath = path.join(dir, entry);
		const stats = fs.statSync(fullPath);

		// If this entry is a directory, recurse into it, unless it is generated or excluded.
		if (stats.isDirectory()) {
			if (!fs.existsSync(path.join(fullPath, ".GENERATED")) && !EXCLUDE_DIRS.includes(entry)) {
				results.push(...findFiles(fullPath, extensions));
			}
		} else if (extensions.includes(path.extname(entry))) {
			if (!shouldExcludeFile(fullPath)) {
				results.push(fullPath);
			}
		}
	}

	// Return the results.
	return results;
}

/**
 * Check if a file has a copyright statement
 */
function hasCopyright(filePath: string): boolean {
	// Load file content.
	const content = fs.readFileSync(filePath, "utf-8");

	// Extract the first 1000 characters as the header (speeds up regex matching).
	const header = content.slice(0, 1000);

	// Break the header down into lines.
	const lines = header.split(/\r?\n/);

	// Check for shebang line.
	if (lines[0].match(SHEBANG_REGEX)) {
		// Remove the shebang line.
		lines.shift();

		// Remove following blank line, if present.
		if (lines[0] === "") {
			lines.shift();
		}
	}

	/**
	 * Regex match header lines.
	 * @param headerLines The header lines.
	 * @returns true, if all lines match; false otherwise.
	 */
	const regexMatchHeaderLines = (headerLines: RegExp[]) => {
		for (let i = 0; i < headerLines.length; i++) {
			if (!lines[i]?.match(headerLines[i])) {
				return false;
			}
		}

		return true;
	};

	// Match the copyright header lines.
	return regexMatchHeaderLines(COPYRIGHT_HEADER_LINES_REGEX);
}

/**
 * Run the hygiene check
 * @param filePaths Optional list of specific file paths to check (from lint-staged).
 * @returns The hygiene check result.
 */
function runHygieneCheck(filePaths?: string[]): HygieneCheckResult {
	// Get the project root.
	const projectRoot = path.resolve(__dirname, "..");

	// Alert start of hygiene check.
	console.log("Running hygiene check...\n");

	let files: string[];

	if (filePaths && filePaths.length > 0) {
		// Use the provided file paths (from lint-staged), filtering to supported extensions.
		files = filePaths
			.map((f) => (path.isAbsolute(f) ? f : path.resolve(f)))
			.filter((f) => FILE_EXTENSIONS.includes(path.extname(f)))
			.filter((f) => !shouldExcludeFile(f));
	} else {
		// Find all relevant files in the src directory.
		const srcDir = path.join(projectRoot, "src");
		files = findFiles(srcDir, FILE_EXTENSIONS);
	}

	// Log the number of files found and what's being checked.
	console.log(`Checking ${files.length} files for copyright statements...\n`);

	// Find files missing copyright.
	const missingCopyright: string[] = [];
	for (const file of files) {
		if (!hasCopyright(file)) {
			// Make path relative to project root for cleaner output
			const relativePath = path.relative(projectRoot, file);
			missingCopyright.push(relativePath);
		}
	}

	// Return the result.
	return {
		missingCopyright,
		checked: files.length,
	};
}

/**
 * Main entry point
 */
function main() {
	try {
		// Check for file path arguments (passed by lint-staged).
		const filePaths = process.argv.slice(2);

		// Run the hygiene check.
		const hygieneCheckResult = runHygieneCheck(filePaths.length > 0 ? filePaths : undefined);

		// Output results.
		if (hygieneCheckResult.missingCopyright.length === 0) {
			console.log(`✓ All ${hygieneCheckResult.checked} files have copyright statements\n`);
			process.exit(0);
		} else {
			console.error(
				`✗ Found ${hygieneCheckResult.missingCopyright.length} file(s) missing copyright statements:\n`,
			);

			for (const file of hygieneCheckResult.missingCopyright) {
				console.error(`  - ${file}`);
			}

			console.error(`\nPlease add the following copyright header to the top of each file:\n`);
			console.error(
				`/*---------------------------------------------------------------------------------------------`,
			);
			console.error(
				` *  Copyright (C) ${new Date().getFullYear()} Posit Software, PBC. All rights reserved.`,
			);
			console.error(
				` *--------------------------------------------------------------------------------------------*/\n`,
			);

			process.exit(1);
		}
	} catch (error) {
		console.error("Error running hygiene check:", error);
		process.exit(1);
	}
}

// Run main.
main();
