#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	copyFile,
	link,
	mkdir,
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

import { createBuildInputs } from "./build-inputs";

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDir = path.join(packageDir, "dist");
const stateDir = path.join(packageDir, ".bridge-watch");
const stagingRoot = path.join(stateDir, "staging");
const generationFile = path.join(stateDir, "generation.json");
const lockDirectory = path.join(stateDir, "coordinator.lock");
const LOCK_INITIALIZATION_GRACE_MS = 5_000;
const buildInputs = createBuildInputs(packageDir);

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

interface StoredGenerationRecord {
	generation: number;
	inputFingerprint?: string;
	manifest: string[];
	digests: Record<string, string>;
	completedAt: string;
}

export interface GenerationRecord extends StoredGenerationRecord {
	inputFingerprint: string;
}

interface LockRecord {
	pid: number;
	token: string;
	startedAt: string;
}

interface LockObservation {
	identity: string;
	kind: "directory" | "file";
	owner: LockRecord | null;
	ageMs: number;
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

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function isLockRecord(value: unknown): value is LockRecord {
	if (!value || typeof value !== "object") return false;
	const candidate = Object.getOwnPropertyDescriptors(value);
	return (
		typeof candidate.pid?.value === "number" &&
		Number.isInteger(candidate.pid.value) &&
		typeof candidate.token?.value === "string" &&
		typeof candidate.startedAt?.value === "string"
	);
}

async function observeLock(targetLockDirectory: string): Promise<LockObservation> {
	const lockStat = await stat(targetLockDirectory);
	let owner: LockRecord | null = null;
	try {
		const parsed: unknown = JSON.parse(
			await readFile(
				lockStat.isDirectory() ? path.join(targetLockDirectory, "owner.json") : targetLockDirectory,
				"utf8",
			),
		);
		if (isLockRecord(parsed)) owner = parsed;
	} catch {
		// Legacy or interrupted lock formats may not contain a valid owner record.
	}
	return {
		identity: `${lockStat.dev}:${lockStat.ino}:${lockStat.birthtimeMs}`,
		kind: lockStat.isDirectory() ? "directory" : "file",
		owner,
		ageMs: Date.now() - lockStat.mtimeMs,
	};
}

async function prepareLockFile(targetLockPath: string, record: LockRecord): Promise<string> {
	const preparedFile = `${targetLockPath}.pending-${record.token}`;
	await writeFile(preparedFile, `${JSON.stringify(record)}\n`, { flag: "wx" });
	return preparedFile;
}

async function publishPreparedLock(preparedFile: string, targetLockPath: string): Promise<boolean> {
	try {
		// A hard link is an atomic no-replace claim: unlike rename, it cannot replace
		// an existing empty directory left by an older coordinator implementation.
		await link(preparedFile, targetLockPath);
		return true;
	} catch (error) {
		try {
			await stat(targetLockPath);
			return false;
		} catch (observationError) {
			if ((observationError as NodeJS.ErrnoException).code === "ENOENT") throw error;
			throw observationError;
		}
	}
}

function liveOwnerError(owner: LockRecord): Error {
	return new Error(
		`Another bridge coordinator is active (pid ${owner.pid}, started ${owner.startedAt}). Stop it before starting this watch.`,
	);
}

export async function acquireCoordinatorLock(
	targetLockDirectory = lockDirectory,
): Promise<() => Promise<void>> {
	await mkdir(path.dirname(targetLockDirectory), { recursive: true });
	const token = randomUUID();
	const record: LockRecord = { pid: process.pid, token, startedAt: new Date().toISOString() };
	let preparedFile = await prepareLockFile(targetLockDirectory, record);

	try {
		for (;;) {
			if (await publishPreparedLock(preparedFile, targetLockDirectory)) {
				const publishedFile = preparedFile;
				preparedFile = "";
				await rm(publishedFile, { force: true }).catch(() => {});
				break;
			}

			let observed: LockObservation;
			try {
				observed = await observeLock(targetLockDirectory);
			} catch (observationError) {
				if ((observationError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw observationError;
			}
			if (observed.owner && processIsAlive(observed.owner.pid)) {
				throw liveOwnerError(observed.owner);
			}
			if (!observed.owner && observed.ageMs < LOCK_INITIALIZATION_GRACE_MS) {
				throw new Error("Another bridge coordinator lock is still initializing.");
			}

			if (observed.kind === "file") {
				const legacyTakeoverDirectory = `${targetLockDirectory}.legacy-takeover`;
				try {
					await mkdir(legacyTakeoverDirectory);
				} catch (takeoverError) {
					const code = (takeoverError as NodeJS.ErrnoException).code;
					if (code === "EEXIST") {
						throw new Error("Another bridge coordinator is recovering a stale file lock.");
					}
					throw takeoverError;
				}
				try {
					const claimed = await observeLock(targetLockDirectory);
					if (
						claimed.identity !== observed.identity ||
						claimed.kind !== "file" ||
						(claimed.owner && processIsAlive(claimed.owner.pid))
					) {
						continue;
					}
					const quarantineFile = `${targetLockDirectory}.stale-${randomUUID()}`;
					await rename(targetLockDirectory, quarantineFile);
					await rm(quarantineFile, { force: true });
				} catch (claimError) {
					if ((claimError as NodeJS.ErrnoException).code !== "ENOENT") throw claimError;
				} finally {
					await rm(legacyTakeoverDirectory, { recursive: true, force: true });
				}
				continue;
			}

			const takeoverDirectory = path.join(targetLockDirectory, ".stale-takeover");
			try {
				await mkdir(takeoverDirectory);
			} catch (takeoverError) {
				const code = (takeoverError as NodeJS.ErrnoException).code;
				if (code === "ENOENT") continue;
				if (code === "EEXIST") {
					throw new Error("Another bridge coordinator is recovering a stale lock.");
				}
				throw takeoverError;
			}

			let claimed: LockObservation;
			try {
				claimed = await observeLock(targetLockDirectory);
				if (claimed.identity !== observed.identity) {
					await rm(takeoverDirectory, { recursive: true, force: true });
					if (claimed.owner && processIsAlive(claimed.owner.pid)) {
						throw liveOwnerError(claimed.owner);
					}
					continue;
				}
				if (claimed.owner && processIsAlive(claimed.owner.pid)) {
					await rm(takeoverDirectory, { recursive: true, force: true });
					throw liveOwnerError(claimed.owner);
				}
				if (!claimed.owner && observed.ageMs < LOCK_INITIALIZATION_GRACE_MS) {
					await rm(takeoverDirectory, { recursive: true, force: true });
					throw new Error("Another bridge coordinator lock is still initializing.");
				}
			} catch (claimError) {
				if ((claimError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw claimError;
			}

			const quarantineDirectory = `${targetLockDirectory}.stale-${randomUUID()}`;
			try {
				await rename(targetLockDirectory, quarantineDirectory);
			} catch (renameError) {
				if ((renameError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw renameError;
			}
			await rm(quarantineDirectory, { recursive: true, force: true });
		}
	} finally {
		if (preparedFile) {
			await rm(preparedFile, { force: true });
		}
	}

	return async () => {
		try {
			const observed = await observeLock(targetLockDirectory);
			if (observed.owner?.token === token) {
				await rm(targetLockDirectory, { recursive: true, force: true });
			}
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

function isStoredGenerationRecord(value: unknown): value is StoredGenerationRecord {
	if (!value || typeof value !== "object") return false;
	const candidate = Object.getOwnPropertyDescriptors(value);
	const manifest: unknown = candidate.manifest?.value;
	const digests: unknown = candidate.digests?.value;
	const inputFingerprint: unknown = candidate.inputFingerprint?.value;
	return (
		typeof candidate.generation?.value === "number" &&
		(inputFingerprint === undefined || typeof inputFingerprint === "string") &&
		typeof candidate.completedAt?.value === "string" &&
		Array.isArray(manifest) &&
		manifest.every((file) => typeof file === "string") &&
		!!digests &&
		typeof digests === "object" &&
		Object.values(digests).every((digest) => typeof digest === "string")
	);
}

function hasInputFingerprint(record: StoredGenerationRecord): record is GenerationRecord {
	return typeof record.inputFingerprint === "string";
}

async function readPreviousRecord(
	recordFile = generationFile,
): Promise<StoredGenerationRecord | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(recordFile, "utf8"));
		return isStoredGenerationRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/**
 * Returns the previous generation when its recorded inputs match
 * `currentFingerprint` and the live dist files still match its digests, so
 * startup can skip an identical rebuild. Any doubt — a missing or legacy
 * record, or a missing or modified output — disqualifies reuse.
 */
export async function reusableGeneration(
	currentFingerprint: string,
	destinationDir = distDir,
	recordFile = generationFile,
): Promise<GenerationRecord | null> {
	const record = await readPreviousRecord(recordFile);
	if (
		!record ||
		!hasInputFingerprint(record) ||
		record.inputFingerprint !== currentFingerprint ||
		record.manifest.length === 0
	) {
		return null;
	}
	try {
		const liveDigests = await digestFiles(destinationDir, record.manifest);
		if (record.manifest.some((file) => liveDigests[file] !== record.digests[file])) return null;
	} catch {
		return null;
	}
	return record;
}

function announceGeneration(record: GenerationRecord): void {
	console.log(
		`${BRIDGE_GENERATION_EVENT} ${JSON.stringify({ generation: record.generation, completedAt: record.completedAt })}`,
	);
}

async function publishRecord(record: GenerationRecord): Promise<void> {
	await mkdir(stateDir, { recursive: true });
	const temporary = `${generationFile}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`);
	await rename(temporary, generationFile);
	announceGeneration(record);
}

async function buildGeneration(fingerprint: string): Promise<void> {
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
			inputFingerprint: fingerprint,
			manifest,
			digests: await digestFiles(stageDir, manifest),
			completedAt: new Date().toISOString(),
		});
	} finally {
		await rm(stageDir, { recursive: true, force: true });
	}
}

export class GenerationBuildLoop {
	private running: Promise<void> | null = null;
	private pending = false;
	private lastSuccessfulInput: string | null = null;

	constructor(
		private readonly fingerprint: () => Promise<string>,
		private readonly buildNextGeneration: (fingerprint: string) => Promise<void>,
		private readonly reportIncrementalFailure: (error: unknown) => void,
	) {}

	initialize(): Promise<void> {
		this.pending = true;
		return this.ensureRunning(true);
	}

	/**
	 * Adopts a fingerprint whose build outputs are already live (a verified
	 * previous generation), so requests with identical inputs skip the rebuild.
	 */
	seed(fingerprint: string): void {
		this.lastSuccessfulInput = fingerprint;
	}

	request(): Promise<void> {
		this.pending = true;
		const running = this.ensureRunning(false);
		// Callers such as fs.watch intentionally fire and forget. Attach a terminal
		// rejection handler even though incremental failures are normally absorbed
		// inside drain(), so an unexpected loop failure is never unhandled.
		void running.catch(this.reportIncrementalFailure);
		return running;
	}

	private ensureRunning(propagateFirstFailure: boolean): Promise<void> {
		if (this.running) return this.running;
		const running = this.drain(propagateFirstFailure).finally(() => {
			if (this.running === running) this.running = null;
		});
		this.running = running;
		return running;
	}

	private async drain(propagateFirstFailure: boolean): Promise<void> {
		let firstAttempt = true;
		while (this.pending) {
			this.pending = false;
			try {
				const currentInput = await this.fingerprint();
				if (currentInput === this.lastSuccessfulInput) continue;
				await this.buildNextGeneration(currentInput);
				this.lastSuccessfulInput = currentInput;
			} catch (error) {
				if (propagateFirstFailure && firstAttempt) throw error;
				this.reportIncrementalFailure(error);
			} finally {
				firstAttempt = false;
			}
		}
	}
}

async function watchGenerations(): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	const loop = new GenerationBuildLoop(
		() => buildInputs.snapshot(),
		buildGeneration,
		(error) => {
			console.error(`Bridge generation failed; keeping last-good exports: ${String(error)}`);
		},
	);
	const schedule = () => {
		clearTimeout(timer);
		timer = setTimeout(() => void loop.request(), 75);
	};

	let stop: (() => void) | null = null;
	const stopped = new Promise<void>((resolve) => {
		stop = resolve;
	});
	const handleSignal = () => stop?.();
	process.once("SIGINT", handleSignal);
	process.once("SIGTERM", handleSignal);
	let restartRequired: string | null = null;
	let watcherFailure: unknown = null;
	const inputWatcher = await buildInputs.watch((change) => {
		if (change.kind === "error") {
			watcherFailure = change.error;
			console.error(`Bridge build-input watcher failed: ${String(change.error)}`);
			process.exitCode = 1;
			stop?.();
			return;
		}
		if (change.kind === "restart") {
			restartRequired = change.changedPath;
			console.error(`Bridge build definition changed; restart required: ${change.changedPath}`);
			process.exitCode = 1;
			stop?.();
			return;
		}
		schedule();
	});
	try {
		// The build-input module watches the same inventory it fingerprints. It
		// starts before the reuse check so any concurrent change is reconciled.
		const startupFingerprint = await buildInputs.snapshot();
		const reusable = await reusableGeneration(startupFingerprint);
		if (watcherFailure !== null) {
			throw new Error("Bridge build-input watcher failed during startup", {
				cause: watcherFailure,
			});
		}
		if (restartRequired) {
			throw new Error(`Bridge build definition changed during startup: ${restartRequired}`);
		}
		if (reusable) {
			loop.seed(startupFingerprint);
			console.log(
				`bridge coordinator: reusing generation ${reusable.generation} (inputs unchanged)`,
			);
			announceGeneration(reusable);
		} else {
			await loop.initialize();
		}
		console.log("bridge coordinator: watching for changes...");
		await stopped;
	} finally {
		process.off("SIGINT", handleSignal);
		process.off("SIGTERM", handleSignal);
		clearTimeout(timer);
		await inputWatcher.close();
	}
}

async function main(): Promise<void> {
	const releaseLock = await acquireCoordinatorLock();
	try {
		if (process.argv.includes("--clean")) {
			await rm(distDir, { recursive: true, force: true });
			await rm(generationFile, { force: true });
		}
		await mkdir(distDir, { recursive: true });
		if (process.argv.includes("--watch")) await watchGenerations();
		else {
			const fingerprint = await buildInputs.snapshot();
			const reusable = await reusableGeneration(fingerprint);
			// A one-shot run has no watcher to reconcile an edit during output
			// verification, so confirm the input snapshot before announcing reuse.
			const confirmedFingerprint = reusable ? await buildInputs.snapshot() : fingerprint;
			if (reusable && confirmedFingerprint === fingerprint) {
				console.log(
					`bridge coordinator: reusing generation ${reusable.generation} (inputs unchanged)`,
				);
				announceGeneration(reusable);
			} else {
				await buildGeneration(confirmedFingerprint);
			}
		}
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
