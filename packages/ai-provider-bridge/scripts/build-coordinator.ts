#!/usr/bin/env node
/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { watch } from "node:fs";
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
const readyFile = path.join(stateDir, "ready.json");
const lockDirectory = path.join(stateDir, "coordinator.lock");
const LOCK_INITIALIZATION_GRACE_MS = 5_000;
const ROLE_RETRY_MS = 100;
const GENERATION_POLL_MS = 500;
const WRITER_LIVENESS_POLL_MS = 1_000;
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

export type CoordinatorMode = "watch" | "oneshot";

export interface LockRecord {
	pid: number;
	token: string;
	startedAt: string;
	mode: CoordinatorMode;
}

export interface ObservedOwner {
	pid: number;
	token: string;
	startedAt: string;
	mode: CoordinatorMode | "unknown";
}

export interface ObservedWatchOwner extends ObservedOwner {
	mode: "watch";
}

interface LockObservation {
	identity: string;
	kind: "directory" | "file";
	owner: ObservedOwner | null;
	ageMs: number;
}

export type CoordinatorRole =
	| { kind: "writer"; release: () => Promise<void>; owner: LockRecord }
	| { kind: "follower"; owner: ObservedWatchOwner };

export type PublicationPolicy = { kind: "watch"; token: string } | { kind: "oneshot" };

interface ReadyRecord {
	token: string;
	generation: number;
}

export interface CoordinatorPaths {
	distDir: string;
	stateDir: string;
	stagingRoot: string;
	generationFile: string;
	readyFile: string;
	lockDirectory: string;
}

const defaultCoordinatorPaths: CoordinatorPaths = {
	distDir,
	stateDir,
	stagingRoot,
	generationFile,
	readyFile,
	lockDirectory,
};

interface LockRuntime {
	processIsAlive: (pid: number) => boolean;
	now: () => number;
}

export interface CoordinatorRoleOptions {
	lockDirectory?: string;
	processIsAlive?: (pid: number) => boolean;
	now?: () => number;
	wait?: (milliseconds: number) => Promise<void>;
	unknownOwnerGraceMs?: number;
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

function parseObservedOwner(value: unknown): ObservedOwner | null {
	if (!value || typeof value !== "object") return null;
	const candidate = Object.getOwnPropertyDescriptors(value);
	if (
		typeof candidate.pid?.value === "number" &&
		Number.isInteger(candidate.pid.value) &&
		typeof candidate.token?.value === "string" &&
		typeof candidate.startedAt?.value === "string"
	) {
		const mode = candidate.mode?.value;
		return {
			pid: candidate.pid.value,
			token: candidate.token.value,
			startedAt: candidate.startedAt.value,
			mode: mode === "watch" || mode === "oneshot" ? mode : "unknown",
		};
	}
	return null;
}

async function observeLock(
	targetLockDirectory: string,
	runtime: LockRuntime,
): Promise<LockObservation> {
	const lockStat = await stat(targetLockDirectory);
	let owner: ObservedOwner | null = null;
	try {
		const parsed: unknown = JSON.parse(
			await readFile(
				lockStat.isDirectory() ? path.join(targetLockDirectory, "owner.json") : targetLockDirectory,
				"utf8",
			),
		);
		owner = parseObservedOwner(parsed);
	} catch {
		// Legacy or interrupted lock formats may not contain a valid owner record.
	}
	return {
		identity: `${lockStat.dev}:${lockStat.ino}:${lockStat.birthtimeMs}`,
		kind: lockStat.isDirectory() ? "directory" : "file",
		owner,
		ageMs: runtime.now() - lockStat.mtimeMs,
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

export class LiveOwnerError extends Error {
	constructor(
		readonly owner: ObservedOwner,
		suffix = "Stop it before starting another bridge coordinator.",
	) {
		super(
			`Another bridge coordinator is active (pid ${owner.pid}, started ${owner.startedAt}). ${suffix}`,
		);
		this.name = "LiveOwnerError";
	}
}

export class LockContendedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LockContendedError";
	}
}

export interface WriterLockClaim {
	owner: LockRecord;
	release: () => Promise<void>;
}

export async function claimWriterLock(
	mode: CoordinatorMode,
	targetLockDirectory = lockDirectory,
	runtime: LockRuntime = { processIsAlive, now: Date.now },
): Promise<WriterLockClaim> {
	await mkdir(path.dirname(targetLockDirectory), { recursive: true });
	const token = randomUUID();
	const record: LockRecord = {
		pid: process.pid,
		token,
		startedAt: new Date(runtime.now()).toISOString(),
		mode,
	};
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
				observed = await observeLock(targetLockDirectory, runtime);
			} catch (observationError) {
				if ((observationError as NodeJS.ErrnoException).code === "ENOENT") continue;
				throw observationError;
			}
			if (observed.owner && runtime.processIsAlive(observed.owner.pid)) {
				throw new LiveOwnerError(observed.owner);
			}
			if (!observed.owner && observed.ageMs < LOCK_INITIALIZATION_GRACE_MS) {
				throw new LockContendedError("Another bridge coordinator lock is still initializing.");
			}

			if (observed.kind === "file") {
				const legacyTakeoverDirectory = `${targetLockDirectory}.legacy-takeover`;
				try {
					await mkdir(legacyTakeoverDirectory);
				} catch (takeoverError) {
					const code = (takeoverError as NodeJS.ErrnoException).code;
					if (code === "EEXIST") {
						throw new LockContendedError(
							"Another bridge coordinator is recovering a stale file lock.",
						);
					}
					throw takeoverError;
				}
				try {
					const claimed = await observeLock(targetLockDirectory, runtime);
					if (
						claimed.identity !== observed.identity ||
						claimed.kind !== "file" ||
						(claimed.owner && runtime.processIsAlive(claimed.owner.pid))
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
					throw new LockContendedError("Another bridge coordinator is recovering a stale lock.");
				}
				throw takeoverError;
			}

			let claimed: LockObservation;
			try {
				claimed = await observeLock(targetLockDirectory, runtime);
				if (claimed.identity !== observed.identity) {
					await rm(takeoverDirectory, { recursive: true, force: true });
					if (claimed.owner && runtime.processIsAlive(claimed.owner.pid)) {
						throw new LiveOwnerError(claimed.owner);
					}
					continue;
				}
				if (claimed.owner && runtime.processIsAlive(claimed.owner.pid)) {
					await rm(takeoverDirectory, { recursive: true, force: true });
					throw new LiveOwnerError(claimed.owner);
				}
				if (!claimed.owner && observed.ageMs < LOCK_INITIALIZATION_GRACE_MS) {
					await rm(takeoverDirectory, { recursive: true, force: true });
					throw new LockContendedError("Another bridge coordinator lock is still initializing.");
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

	const release = async () => {
		try {
			const observed = await observeLock(targetLockDirectory, runtime);
			if (observed.owner?.token === token) {
				await rm(targetLockDirectory, { recursive: true, force: true });
			}
		} catch {
			// The owner token prevents this process from removing a replacement lock.
		}
	};
	return { owner: record, release };
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isObservedWatchOwner(owner: ObservedOwner): owner is ObservedWatchOwner {
	return owner.mode === "watch";
}

export async function acquireCoordinatorRole(
	mode: CoordinatorMode,
	options: CoordinatorRoleOptions = {},
): Promise<CoordinatorRole> {
	const runtime: LockRuntime = {
		processIsAlive: options.processIsAlive ?? processIsAlive,
		now: options.now ?? Date.now,
	};
	const wait = options.wait ?? delay;
	const unknownOwnerGraceMs = options.unknownOwnerGraceMs ?? LOCK_INITIALIZATION_GRACE_MS;
	let unknownOwnerDeadline: number | null = null;

	for (;;) {
		try {
			const claim = await claimWriterLock(mode, options.lockDirectory, runtime);
			return { kind: "writer", ...claim };
		} catch (error) {
			if (error instanceof LiveOwnerError) {
				if (mode === "oneshot") {
					const suffix = isObservedWatchOwner(error.owner)
						? "Stop the bridge watch before installing or running a clean build."
						: "Wait for it to finish before running this one-shot build.";
					throw new LiveOwnerError(error.owner, suffix);
				}
				if (isObservedWatchOwner(error.owner)) {
					return { kind: "follower", owner: error.owner };
				}
				if (error.owner.mode === "unknown") {
					unknownOwnerDeadline ??= runtime.now() + unknownOwnerGraceMs;
					if (runtime.now() >= unknownOwnerDeadline) {
						throw new LiveOwnerError(
							error.owner,
							"Its legacy lock does not declare watch intent; stop it before retrying.",
						);
					}
				}
				await wait(ROLE_RETRY_MS);
				continue;
			}
			if (error instanceof LockContendedError) {
				await wait(ROLE_RETRY_MS);
				continue;
			}
			throw error;
		}
	}
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

async function writeJsonAtomically(filePath: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(filePath), { recursive: true });
	const temporary = `${filePath}.${randomUUID()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
	try {
		await rename(temporary, filePath);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}

export async function publishGeneration(
	record: GenerationRecord,
	policy: PublicationPolicy,
	paths: CoordinatorPaths = defaultCoordinatorPaths,
	announce: (record: GenerationRecord) => void = announceGeneration,
): Promise<void> {
	await writeJsonAtomically(paths.generationFile, record);
	if (policy.kind === "watch") {
		const ready: ReadyRecord = { token: policy.token, generation: record.generation };
		await writeJsonAtomically(paths.readyFile, ready);
	}
	announce(record);
}

async function buildGeneration(
	fingerprint: string,
	policy: PublicationPolicy,
	paths: CoordinatorPaths = defaultCoordinatorPaths,
): Promise<void> {
	const previous = await readPreviousRecord(paths.generationFile);
	const generation = (previous?.generation ?? 0) + 1;
	const stageDir = path.join(paths.stagingRoot, `${generation}-${randomUUID()}`);
	await mkdir(stageDir, { recursive: true });
	try {
		await Promise.all([build(buildOptions(stageDir)), runDeclarations(stageDir)]);
		await rm(path.join(stageDir, ".tsbuildinfo"), { force: true });
		const exportedTargets = await validateGeneration(stageDir);
		const manifest = await listFiles(stageDir);
		await promoteGeneration(stageDir, manifest, exportedTargets, paths.distDir, paths.stateDir);

		const live = new Set(manifest);
		for (const stale of previous?.manifest ?? []) {
			if (!live.has(stale)) await rm(path.join(paths.distDir, stale), { force: true });
		}

		await publishGeneration(
			{
				generation,
				inputFingerprint: fingerprint,
				manifest,
				digests: await digestFiles(stageDir, manifest),
				completedAt: new Date().toISOString(),
			},
			policy,
			paths,
		);
	} finally {
		await rm(stageDir, { recursive: true, force: true });
	}
}

function isReadyRecord(value: unknown): value is ReadyRecord {
	if (!value || typeof value !== "object") return false;
	const candidate = Object.getOwnPropertyDescriptors(value);
	return (
		typeof candidate.token?.value === "string" && typeof candidate.generation?.value === "number"
	);
}

async function readReadyRecord(filePath: string): Promise<ReadyRecord | null> {
	try {
		const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"));
		return isReadyRecord(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

async function digestValidGeneration(
	destinationDir: string,
	recordFile: string,
): Promise<GenerationRecord | null> {
	const record = await readPreviousRecord(recordFile);
	if (!record || !hasInputFingerprint(record) || record.manifest.length === 0) return null;
	try {
		const liveDigests = await digestFiles(destinationDir, record.manifest);
		if (record.manifest.some((file) => liveDigests[file] !== record.digests[file])) return null;
		return record;
	} catch {
		return null;
	}
}

export interface Closeable {
	close(): void;
}

export interface GenerationObserverAdapters {
	watchDirectory: (directory: string, onChange: () => void) => Closeable;
	schedulePoll: (onPoll: () => void, milliseconds: number) => Closeable;
}

function defaultObserverAdapters(): GenerationObserverAdapters {
	return {
		watchDirectory: (directory, onChange) => {
			const watcher = watch(directory, onChange);
			watcher.on("error", onChange);
			return { close: () => watcher.close() };
		},
		schedulePoll: (onPoll, milliseconds) => {
			const timer = setInterval(onPoll, milliseconds);
			return { close: () => clearInterval(timer) };
		},
	};
}

export interface GenerationObserverOptions {
	paths?: CoordinatorPaths;
	adapters?: GenerationObserverAdapters;
	pollMilliseconds?: number;
	processIsAlive?: (pid: number) => boolean;
}

export class GenerationObserver {
	private readonly paths: CoordinatorPaths;
	private readonly adapters: GenerationObserverAdapters;
	private readonly pollMilliseconds: number;
	private readonly processIsAlive: (pid: number) => boolean;

	constructor(
		private readonly owner: ObservedWatchOwner,
		options: GenerationObserverOptions = {},
	) {
		this.paths = options.paths ?? defaultCoordinatorPaths;
		this.adapters = options.adapters ?? defaultObserverAdapters();
		this.pollMilliseconds = options.pollMilliseconds ?? GENERATION_POLL_MS;
		this.processIsAlive = options.processIsAlive ?? processIsAlive;
	}

	private async currentWatchOwner(): Promise<ObservedWatchOwner | null> {
		try {
			const observation = await observeLock(this.paths.lockDirectory, {
				processIsAlive: this.processIsAlive,
				now: Date.now,
			});
			if (
				observation.owner &&
				isObservedWatchOwner(observation.owner) &&
				this.processIsAlive(observation.owner.pid)
			) {
				return observation.owner;
			}
		} catch {
			// A lock can disappear while the writer is exiting. Polling will retry.
		}
		return null;
	}

	observe(onGeneration: (record: GenerationRecord) => void, signal?: AbortSignal): Closeable {
		let closed = false;
		let running = false;
		let pending = false;
		let lastGeneration = -1;

		const scan = async (): Promise<void> => {
			if (closed) return;
			if (running) {
				pending = true;
				return;
			}
			running = true;
			try {
				do {
					pending = false;
					const [currentOwner, ready, generation] = await Promise.all([
						this.currentWatchOwner(),
						readReadyRecord(this.paths.readyFile),
						digestValidGeneration(this.paths.distDir, this.paths.generationFile),
					]);
					if (
						!closed &&
						currentOwner?.token === this.owner.token &&
						ready?.token === currentOwner.token &&
						generation &&
						ready.generation === generation.generation &&
						generation.generation > lastGeneration
					) {
						lastGeneration = generation.generation;
						onGeneration(generation);
					}
				} while (pending && !closed);
			} finally {
				running = false;
			}
		};
		const requestScan = () => void scan();
		let directoryWatcher: Closeable | null = null;
		try {
			directoryWatcher = this.adapters.watchDirectory(this.paths.stateDir, requestScan);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const polling = this.adapters.schedulePoll(requestScan, this.pollMilliseconds);
		const close = () => {
			if (closed) return;
			closed = true;
			directoryWatcher?.close();
			polling.close();
			signal?.removeEventListener("abort", close);
		};
		signal?.addEventListener("abort", close, { once: true });
		if (signal?.aborted) close();
		else requestScan();
		return { close };
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

async function watchGenerations(
	owner: LockRecord,
	paths: CoordinatorPaths = defaultCoordinatorPaths,
): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	const policy: PublicationPolicy = { kind: "watch", token: owner.token };
	const loop = new GenerationBuildLoop(
		() => buildInputs.snapshot(),
		(fingerprint) => buildGeneration(fingerprint, policy, paths),
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
		const reusable = await reusableGeneration(
			startupFingerprint,
			paths.distDir,
			paths.generationFile,
		);
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
			await publishGeneration(reusable, policy, paths);
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

export interface FollowGenerationOptions {
	observer?: GenerationObserver;
	processIsAlive?: (pid: number) => boolean;
	monitorLiveness?: (check: () => void, milliseconds: number) => Closeable;
	announce?: (record: GenerationRecord) => void;
}

function defaultLivenessMonitor(check: () => void, milliseconds: number): Closeable {
	const timer = setInterval(check, milliseconds);
	return { close: () => clearInterval(timer) };
}

export async function followGenerations(
	owner: ObservedWatchOwner,
	options: FollowGenerationOptions = {},
): Promise<void> {
	const observer = options.observer ?? new GenerationObserver(owner);
	const isAlive = options.processIsAlive ?? processIsAlive;
	const monitorLiveness = options.monitorLiveness ?? defaultLivenessMonitor;
	const announce = options.announce ?? announceGeneration;
	let finish!: (error?: Error) => void;
	const stopped = new Promise<void>((resolve, reject) => {
		finish = (error) => (error ? reject(error) : resolve());
	});
	const handleSignal = () => finish();
	process.once("SIGINT", handleSignal);
	process.once("SIGTERM", handleSignal);
	const subscription = observer.observe(announce);
	const liveness = monitorLiveness(() => {
		if (!isAlive(owner.pid)) {
			finish(
				new Error(
					`Bridge coordinator writer (pid ${owner.pid}) exited; follower cannot promote in phase 1.`,
				),
			);
		}
	}, WRITER_LIVENESS_POLL_MS);
	console.log(`bridge coordinator: following writer pid ${owner.pid}...`);
	try {
		await stopped;
	} finally {
		process.off("SIGINT", handleSignal);
		process.off("SIGTERM", handleSignal);
		liveness.close();
		subscription.close();
	}
}

export interface RunCoordinatorOptions {
	paths?: CoordinatorPaths;
	roleOptions?: CoordinatorRoleOptions;
	followOptions?: FollowGenerationOptions;
}

export async function runCoordinator(
	args: readonly string[],
	options: RunCoordinatorOptions = {},
): Promise<void> {
	const paths = options.paths ?? defaultCoordinatorPaths;
	const mode: CoordinatorMode = args.includes("--watch") ? "watch" : "oneshot";
	const role = await acquireCoordinatorRole(mode, {
		...options.roleOptions,
		lockDirectory: options.roleOptions?.lockDirectory ?? paths.lockDirectory,
	});
	if (role.kind === "follower") {
		await followGenerations(role.owner, {
			...options.followOptions,
			observer: options.followOptions?.observer ?? new GenerationObserver(role.owner, { paths }),
		});
		return;
	}
	try {
		if (args.includes("--clean")) {
			await rm(paths.distDir, { recursive: true, force: true });
			await Promise.all([
				rm(paths.generationFile, { force: true }),
				rm(paths.readyFile, { force: true }),
			]);
		}
		await mkdir(paths.distDir, { recursive: true });
		if (mode === "watch") await watchGenerations(role.owner, paths);
		else {
			const fingerprint = await buildInputs.snapshot();
			const reusable = await reusableGeneration(fingerprint, paths.distDir, paths.generationFile);
			// A one-shot run has no watcher to reconcile an edit during output
			// verification, so confirm the input snapshot before announcing reuse.
			const confirmedFingerprint = reusable ? await buildInputs.snapshot() : fingerprint;
			if (reusable && confirmedFingerprint === fingerprint) {
				console.log(
					`bridge coordinator: reusing generation ${reusable.generation} (inputs unchanged)`,
				);
				await publishGeneration(reusable, { kind: "oneshot" }, paths);
			} else {
				await buildGeneration(confirmedFingerprint, { kind: "oneshot" }, paths);
			}
		}
	} finally {
		await role.release();
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	void runCoordinator(process.argv.slice(2)).catch((error) => {
		console.error(error);
		process.exitCode = 1;
	});
}
