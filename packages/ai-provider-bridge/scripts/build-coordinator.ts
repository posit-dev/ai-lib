#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import {
	copyFile,
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { builtinModules, createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build, type BuildOptions } from "esbuild";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(packageDir, "dist");
const stateDir = path.join(packageDir, ".bridge-watch");
const stagingRoot = path.join(stateDir, "staging");
const generationFile = path.join(stateDir, "generation.json");
const lockFile = path.join(stateDir, "coordinator.lock");

export const BRIDGE_GENERATION_EVENT = "@@ai-provider-bridge-generation";

const entryPoints = [
	"src/index.ts",
	"src/local-providers.ts",
	"src/types.ts",
	"src/providers.ts",
	"src/positron/index.ts",
	"src/credential-shaping.ts",
];

const externalDeps = [
	"@ai-sdk/amazon-bedrock",
	"@ai-sdk/anthropic",
	"@ai-sdk/deepseek",
	"@ai-sdk/google",
	"@ai-sdk/google-vertex",
	"@ai-sdk/openai",
	"@ai-sdk/openai-compatible",
	"@aws-sdk/client-bedrock",
	"@aws-sdk/credential-providers",
	"@github/copilot-sdk",
	"@openrouter/ai-sdk-provider",
	"ai",
	"ai-sdk-ollama",
	"google-auth-library",
	"vscode",
];

const nodeBuiltins = builtinModules.flatMap((moduleName) => [moduleName, `node:${moduleName}`]);

export interface GenerationRecord {
	generation: number;
	manifest: string[];
	digests: Record<string, string>;
	completedAt: string;
}

interface LockRecord {
	pid: number;
	token: string;
	startedAt: string;
}

async function exists(filePath: string): Promise<boolean> {
	try {
		await stat(filePath);
		return true;
	} catch {
		return false;
	}
}

async function listFiles(root: string, current = root): Promise<string[]> {
	const entries = await readdir(current, { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const absolute = path.join(current, entry.name);
		if (entry.isDirectory()) files.push(...(await listFiles(root, absolute)));
		else if (entry.isFile()) files.push(path.relative(root, absolute).replaceAll(path.sep, "/"));
	}
	return files.sort();
}

async function digestFiles(
	root: string,
	manifest: readonly string[],
): Promise<Record<string, string>> {
	const result: Record<string, string> = {};
	for (const relative of manifest) {
		const content = await readFile(path.join(root, relative));
		result[relative] = createHash("sha256").update(content).digest("hex");
	}
	return result;
}

async function inputFingerprint(): Promise<string> {
	const sourceFiles = await listFiles(path.join(packageDir, "src"));
	const inputs = [
		...sourceFiles.map((relative) => `src/${relative}`),
		"package.json",
		"tsconfig.declarations.json",
	];
	const hash = createHash("sha256");
	for (const relative of inputs) {
		hash.update(relative);
		hash.update("\0");
		hash.update(await readFile(path.join(packageDir, relative)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

async function acquireLock(): Promise<() => Promise<void>> {
	await mkdir(stateDir, { recursive: true });
	const token = randomUUID();
	const record: LockRecord = { pid: process.pid, token, startedAt: new Date().toISOString() };

	for (;;) {
		try {
			const handle = await open(lockFile, "wx");
			await handle.writeFile(`${JSON.stringify(record)}\n`);
			await handle.close();
			break;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			let owner: LockRecord | null = null;
			try {
				owner = JSON.parse(await readFile(lockFile, "utf8")) as LockRecord;
			} catch {
				// An unreadable lock cannot identify a live owner and is recoverable.
			}
			if (owner && processIsAlive(owner.pid)) {
				throw new Error(
					`Another bridge coordinator is active (pid ${owner.pid}, started ${owner.startedAt}). Stop it before starting this watch.`,
				);
			}
			await rm(lockFile, { force: true });
		}
	}

	return async () => {
		try {
			const owner = JSON.parse(await readFile(lockFile, "utf8")) as LockRecord;
			if (owner.token === token) await rm(lockFile, { force: true });
		} catch {
			// The owner token prevents this process from removing a replacement lock.
		}
	};
}

async function runDeclarations(outDir: string): Promise<void> {
	const require = createRequire(import.meta.url);
	const tscPath = path.join(path.dirname(require.resolve("typescript/package.json")), "bin/tsc");
	await new Promise<void>((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				tscPath,
				"-p",
				path.join(packageDir, "tsconfig.declarations.json"),
				"--outDir",
				outDir,
				"--emitDeclarationOnly",
				"--tsBuildInfoFile",
				path.join(outDir, ".tsbuildinfo"),
			],
			{ cwd: packageDir, stdio: "inherit" },
		);
		child.once("error", reject);
		child.once("exit", (code, signal) => {
			if (code === 0) resolve();
			else reject(new Error(`Declaration build failed (${signal ?? `exit ${code}`})`));
		});
	});
}

function buildOptions(outdir: string): BuildOptions {
	return {
		entryPoints,
		absWorkingDir: packageDir,
		bundle: true,
		format: "esm",
		outdir,
		external: [...externalDeps, ...nodeBuiltins],
		platform: "node",
		target: "es2022",
		sourcemap: true,
		splitting: true,
		metafile: true,
		write: true,
	};
}

async function assertVscodeQuarantine(stageDir: string): Promise<void> {
	for (const relative of await listFiles(path.join(packageDir, "src"))) {
		if (!relative.endsWith(".ts") || relative.startsWith("positron/")) continue;
		const source = await readFile(path.join(packageDir, "src", relative), "utf8");
		if (/\b(?:from|import\s*\()\s*["']vscode["']|reference\s+types=["']vscode["']/.test(source)) {
			throw new Error(`VS Code type leak in non-Positron source: src/${relative}`);
		}
	}
	for (const relative of await listFiles(stageDir)) {
		if (!relative.endsWith(".d.ts") || relative.startsWith("positron/")) continue;
		const declaration = await readFile(path.join(stageDir, relative), "utf8");
		if (
			/\b(?:from|import\s*\()\s*["']vscode["']|reference\s+types=["']vscode["']/.test(declaration)
		) {
			throw new Error(`VS Code type leak in non-Positron declaration: ${relative}`);
		}
	}
}

async function validateRelativeDeclarations(stageDir: string): Promise<void> {
	for (const relative of await listFiles(stageDir)) {
		if (!relative.endsWith(".d.ts")) continue;
		const contents = await readFile(path.join(stageDir, relative), "utf8");
		const imports = contents.matchAll(/(?:from\s+|import\s*\()["'](\.[^"']+)["']/g);
		for (const match of imports) {
			const specifier = match[1];
			if (!specifier) continue;
			const resolvedBase = path.resolve(path.dirname(path.join(stageDir, relative)), specifier);
			const candidates = specifier.endsWith(".js")
				? [resolvedBase.slice(0, -3) + ".d.ts", path.join(resolvedBase.slice(0, -3), "index.d.ts")]
				: [`${resolvedBase}.d.ts`, path.join(resolvedBase, "index.d.ts")];
			if (!(await Promise.all(candidates.map(exists))).some(Boolean)) {
				throw new Error(`Unresolved declaration import ${specifier} from ${relative}`);
			}
		}
	}
}

async function validateRuntimeEntrypoints(
	stageDir: string,
	runtimeTargets: readonly string[],
): Promise<void> {
	for (const relative of runtimeTargets) {
		// The Positron entrypoint intentionally requires the host-provided `vscode`
		// module. Its existence and declaration surface are validated here, while
		// runtime loading belongs to the Positron extension host.
		if (relative.startsWith("positron/")) continue;
		try {
			await import(
				`${pathToFileURL(path.join(stageDir, relative)).href}?validation=${randomUUID()}`
			);
		} catch (error) {
			throw new Error(`Unable to import staged runtime entrypoint ${relative}`, { cause: error });
		}
	}
}

export async function validateGeneration(stageDir: string): Promise<string[]> {
	const packageJson = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8")) as {
		exports: Record<string, Record<string, string>>;
	};
	const targets = new Set<string>();
	const runtimeTargets = new Set<string>();
	for (const conditions of Object.values(packageJson.exports)) {
		for (const [condition, target] of Object.entries(conditions)) {
			if (!target.startsWith("./dist/") || target.includes("..")) {
				throw new Error(`Unexpected export target: ${target}`);
			}
			const relative = target.slice("./dist/".length);
			if (condition !== "types") runtimeTargets.add(relative);
			if (targets.has(relative)) continue;
			targets.add(relative);
			if (!(await exists(path.join(stageDir, relative)))) {
				throw new Error(`Missing staged export target: ${relative}`);
			}
		}
	}
	await assertVscodeQuarantine(stageDir);
	await validateRelativeDeclarations(stageDir);
	await validateRuntimeEntrypoints(stageDir, [...runtimeTargets]);
	return [...targets];
}

async function replaceFile(source: string, target: string): Promise<void> {
	await mkdir(path.dirname(target), { recursive: true });
	const temporary = `${target}.bridge-${randomUUID()}.tmp`;
	await copyFile(source, temporary);
	try {
		await rename(temporary, target);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function promoteGeneration(
	stageDir: string,
	manifest: readonly string[],
	exportedTargets: readonly string[],
	destinationDir = distDir,
	promotionStateDir = stateDir,
): Promise<void> {
	const exported = new Set(exportedTargets);
	const ordered = [
		...manifest.filter((file) => !exported.has(file)),
		...manifest.filter((file) => exported.has(file)),
	];
	const rollbackDir = path.join(promotionStateDir, `rollback-${randomUUID()}`);
	const replaced: string[] = [];
	await mkdir(rollbackDir, { recursive: true });
	try {
		for (const relative of ordered) {
			const target = path.join(destinationDir, relative);
			if (await exists(target)) {
				const rollback = path.join(rollbackDir, relative);
				await mkdir(path.dirname(rollback), { recursive: true });
				await copyFile(target, rollback);
			}
			await replaceFile(path.join(stageDir, relative), target);
			replaced.push(relative);
		}
	} catch (error) {
		const rollbackFailures: string[] = [];
		for (const relative of replaced.reverse()) {
			const backup = path.join(rollbackDir, relative);
			try {
				if (await exists(backup)) await replaceFile(backup, path.join(destinationDir, relative));
				else await rm(path.join(destinationDir, relative), { force: true });
			} catch (rollbackError) {
				rollbackFailures.push(`${relative}: ${String(rollbackError)}`);
			}
		}
		const suffix = rollbackFailures.length
			? ` Rollback failures: ${rollbackFailures.join("; ")}`
			: "";
		throw new Error(`Bridge promotion failed: ${String(error)}.${suffix}`, { cause: error });
	} finally {
		await rm(rollbackDir, { recursive: true, force: true });
	}
}

async function readPreviousRecord(): Promise<GenerationRecord | null> {
	try {
		return JSON.parse(await readFile(generationFile, "utf8")) as GenerationRecord;
	} catch {
		return null;
	}
}

async function publishRecord(record: GenerationRecord): Promise<void> {
	await mkdir(stateDir, { recursive: true });
	const temporary = `${generationFile}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
	await rename(temporary, generationFile);
	console.log(
		`${BRIDGE_GENERATION_EVENT} ${JSON.stringify({ generation: record.generation, completedAt: record.completedAt })}`,
	);
}

async function buildGeneration(): Promise<void> {
	const previous = await readPreviousRecord();
	const generation = (previous?.generation ?? 0) + 1;
	const stageDir = path.join(stagingRoot, `${generation}-${randomUUID()}`);
	await mkdir(stageDir, { recursive: true });
	try {
		await Promise.all([build(buildOptions(stageDir)), runDeclarations(stageDir)]);
		await rm(path.join(stageDir, ".tsbuildinfo"), { force: true });
		const exportedTargets = await validateGeneration(stageDir);
		const manifest = await listFiles(stageDir);
		await promoteGeneration(stageDir, manifest, exportedTargets);

		const live = new Set(manifest);
		for (const stale of previous?.manifest ?? []) {
			if (!live.has(stale)) await rm(path.join(distDir, stale), { force: true });
		}

		await publishRecord({
			generation,
			manifest,
			digests: await digestFiles(stageDir, manifest),
			completedAt: new Date().toISOString(),
		});
	} finally {
		await rm(stageDir, { recursive: true, force: true });
	}
}

async function sourceDirectories(root: string): Promise<string[]> {
	const directories = [root];
	for (const entry of await readdir(root, { withFileTypes: true })) {
		if (entry.isDirectory())
			directories.push(...(await sourceDirectories(path.join(root, entry.name))));
	}
	return directories;
}

async function watchGenerations(): Promise<void> {
	let running = false;
	let pending = false;
	let timer: NodeJS.Timeout | undefined;
	let lastSuccessfulInput = await inputFingerprint();
	const rebuild = async () => {
		if (running) {
			pending = true;
			return;
		}
		running = true;
		do {
			pending = false;
			const currentInput = await inputFingerprint();
			if (currentInput === lastSuccessfulInput) continue;
			try {
				await buildGeneration();
				lastSuccessfulInput = currentInput;
			} catch (error) {
				console.error(`Bridge generation failed; keeping last-good exports: ${String(error)}`);
			}
		} while (pending);
		running = false;
	};

	await buildGeneration();
	const watchers: FSWatcher[] = [];
	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(() => void rebuild(), 75);
	};
	for (const directory of await sourceDirectories(path.join(packageDir, "src"))) {
		watchers.push(watch(directory, schedule));
	}
	for (const file of ["package.json", "tsconfig.declarations.json"]) {
		watchers.push(watch(path.join(packageDir, file), schedule));
	}
	console.log("bridge coordinator: watching for changes...");
	await new Promise<void>((resolve) => {
		const stop = () => {
			clearTimeout(timer);
			for (const watcher of watchers) watcher.close();
			resolve();
		};
		process.once("SIGINT", stop);
		process.once("SIGTERM", stop);
	});
}

async function main(): Promise<void> {
	const releaseLock = await acquireLock();
	try {
		if (process.argv.includes("--clean")) {
			await rm(distDir, { recursive: true, force: true });
			await rm(generationFile, { force: true });
		}
		await mkdir(distDir, { recursive: true });
		if (process.argv.includes("--watch")) await watchGenerations();
		else await buildGeneration();
	} finally {
		await releaseLock();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	void main().catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
