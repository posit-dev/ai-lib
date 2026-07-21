/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from "node:crypto";
import { watch as watchFileSystem } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type BuildInputChange =
	| { kind: "error"; error: unknown }
	| { kind: "rebuild" }
	| { kind: "restart"; changedPath: string };

export interface BuildInputWatcher {
	close(): Promise<void>;
}

/**
 * Discovers every local input to the bridge build, fingerprints its current
 * contents, and watches the same inventory. Callers do not maintain separate
 * hash and watch lists.
 */
export interface BuildInputs {
	snapshot(): Promise<string>;
	watch(onChange: (change: BuildInputChange) => void): Promise<BuildInputWatcher>;
}

interface InputInventory {
	files: string[];
	metadataDirectories: MetadataDirectory[];
	restartRoots: string[];
	treeRoots: string[];
}

interface MetadataDirectory {
	directory: string;
	kind: "build" | "dependency";
}

interface PackageMetadata {
	name: string | null;
	workspaceDependencies: string[];
}

interface DirectoryWatch {
	close(): void;
}

/** @internal Test seam; production callers use createBuildInputs(). */
export interface BuildInputWatchAdapter {
	watch(
		directory: string,
		recursive: boolean,
		onChange: (event: "change" | "rename", filename: string | null) => void,
		onError: (error: unknown) => void,
	): DirectoryWatch;
}

const nodeWatchAdapter: BuildInputWatchAdapter = {
	watch(directory, recursive, onChange, onError) {
		const watcher = watchFileSystem(directory, { recursive }, (event, filename) => {
			onChange(event, filename === null ? null : filename.toString());
		});
		watcher.on("error", onError);
		return { close: () => watcher.close() };
	},
};

function errorCode(error: unknown): string | undefined {
	if (!error || typeof error !== "object" || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}

async function isDirectory(target: string): Promise<boolean> {
	try {
		return (await stat(target)).isDirectory();
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
}

async function filesUnder(current: string): Promise<string[]> {
	const files: string[] = [];
	for (const entry of await readdir(current, { withFileTypes: true })) {
		const absolute = path.join(current, entry.name);
		if (entry.isDirectory()) files.push(...(await filesUnder(absolute)));
		else if (entry.isFile()) files.push(absolute);
	}
	return files.sort();
}

function ownValue(value: object, key: string): unknown {
	return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function packageMetadata(value: unknown): PackageMetadata {
	if (!value || typeof value !== "object") {
		throw new Error("Expected package.json to contain an object");
	}
	const rawName = ownValue(value, "name");
	const rawDependencies = ownValue(value, "dependencies");
	const workspaceDependencies: string[] = [];
	if (rawDependencies && typeof rawDependencies === "object") {
		for (const [name, descriptor] of Object.entries(
			Object.getOwnPropertyDescriptors(rawDependencies),
		)) {
			const specifier: unknown = descriptor.value;
			if (
				typeof specifier === "string" &&
				(specifier === "*" || specifier.startsWith("workspace:"))
			) {
				workspaceDependencies.push(name);
			}
		}
	}
	return {
		name: typeof rawName === "string" ? rawName : null,
		workspaceDependencies: workspaceDependencies.sort(),
	};
}

async function readPackageMetadata(packageFile: string): Promise<PackageMetadata> {
	const parsed: unknown = JSON.parse(await readFile(packageFile, "utf8"));
	return packageMetadata(parsed);
}

function isPackageMetadataFile(name: string): boolean {
	return name === "package.json" || (name.startsWith("tsconfig") && name.endsWith(".json"));
}

function isInside(parent: string, candidate: string): boolean {
	const relative = path.relative(parent, candidate);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function workspaceDependencyDirectories(
	packageDir: string,
	workspaceRoot: string,
): Promise<string[]> {
	const { workspaceDependencies } = await readPackageMetadata(
		path.join(packageDir, "package.json"),
	);
	if (workspaceDependencies.length === 0) return [];

	const dependencyNames = new Set(workspaceDependencies);
	const resolved = new Map<string, string>();
	const packagesDir = path.join(workspaceRoot, "packages");
	for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const candidateDir = path.join(packagesDir, entry.name);
		const candidateFile = path.join(candidateDir, "package.json");
		try {
			const candidate = await readPackageMetadata(candidateFile);
			if (candidate.name && dependencyNames.has(candidate.name)) {
				resolved.set(candidate.name, candidateDir);
			}
		} catch (error) {
			if (errorCode(error) !== "ENOENT") throw error;
		}
	}

	const missing = workspaceDependencies.filter((name) => !resolved.has(name));
	if (missing.length > 0) {
		throw new Error(`Unable to locate workspace dependencies: ${missing.join(", ")}`);
	}
	return workspaceDependencies.map((name) => {
		const directory = resolved.get(name);
		if (!directory) throw new Error(`Unable to locate workspace dependency: ${name}`);
		return directory;
	});
}

async function discoverInputs(packageDir: string, workspaceRoot: string): Promise<InputInventory> {
	const sourceRoot = path.join(packageDir, "src");
	const scriptsRoot = path.join(packageDir, "scripts");
	const dependencyDirs = await workspaceDependencyDirectories(packageDir, workspaceRoot);
	const treeRoots = [sourceRoot, scriptsRoot];
	const buildMetadataDirectories = new Set<string>();
	const files = new Set<string>();

	for (
		let current = packageDir;
		isInside(workspaceRoot, current);
		current = path.dirname(current)
	) {
		buildMetadataDirectories.add(current);
		for (const entry of await readdir(current, { withFileTypes: true })) {
			if (entry.isFile() && isPackageMetadataFile(entry.name)) {
				files.add(path.join(current, entry.name));
			}
		}
		if (current === workspaceRoot) break;
	}

	for (const dependencyDir of dependencyDirs) {
		files.add(path.join(dependencyDir, "package.json"));
		const dependencyDist = path.join(dependencyDir, "dist");
		if (await isDirectory(dependencyDist)) treeRoots.push(dependencyDist);
	}

	for (const root of treeRoots) {
		if (await isDirectory(root)) {
			for (const file of await filesUnder(root)) files.add(file);
		}
	}

	return {
		files: [...files].sort(),
		metadataDirectories: [
			...[...buildMetadataDirectories]
				.sort()
				.map((directory): MetadataDirectory => ({ directory, kind: "build" })),
			...dependencyDirs
				.sort()
				.map((directory): MetadataDirectory => ({ directory, kind: "dependency" })),
		],
		restartRoots: [scriptsRoot],
		treeRoots: treeRoots.sort(),
	};
}

function appendFramed(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
	const bytes = typeof value === "string" ? Buffer.from(value) : value;
	hash.update(String(bytes.byteLength));
	hash.update(":");
	hash.update(bytes);
}

export function createBuildInputs(packageDir: string): BuildInputs {
	return createBuildInputsWithAdapter(packageDir, nodeWatchAdapter);
}

/** @internal Test seam; production callers use createBuildInputs(). */
export function createBuildInputsWithAdapter(
	packageDir: string,
	watchAdapter: BuildInputWatchAdapter,
): BuildInputs {
	const resolvedPackageDir = path.resolve(packageDir);
	const workspaceRoot = path.resolve(resolvedPackageDir, "../..");

	const inventory = () => discoverInputs(resolvedPackageDir, workspaceRoot);
	return {
		async snapshot() {
			const { files } = await inventory();
			const contents = await Promise.all(files.map((file) => readFile(file)));
			const hash = createHash("sha256");
			for (const [index, file] of files.entries()) {
				appendFramed(hash, path.relative(workspaceRoot, file).replaceAll(path.sep, "/"));
				const content = contents[index];
				if (!content) throw new Error(`Build input disappeared while fingerprinting: ${file}`);
				appendFramed(hash, content);
			}
			return hash.digest("hex");
		},

		async watch(onChange) {
			const watchers = new Map<
				string,
				{
					metadataKind: MetadataDirectory["kind"] | null;
					recursive: boolean;
					watcher: DirectoryWatch;
				}
			>();
			let closed = false;
			let refreshQueue = Promise.resolve();

			const refresh = async () => {
				if (closed) return;
				const discovered = await inventory();
				const restartRoots = discovered.restartRoots.map((root) => path.resolve(root));
				const desired = new Map<
					string,
					{ metadataKind: MetadataDirectory["kind"] | null; recursive: boolean }
				>();
				for (const { directory, kind } of discovered.metadataDirectories) {
					desired.set(directory, { metadataKind: kind, recursive: false });
				}
				for (const directory of discovered.treeRoots) {
					desired.set(directory, { metadataKind: null, recursive: true });
				}

				for (const [directory, active] of watchers) {
					const wanted = desired.get(directory);
					if (
						wanted?.recursive === active.recursive &&
						wanted.metadataKind === active.metadataKind
					) {
						continue;
					}
					active.watcher.close();
					watchers.delete(directory);
				}
				for (const [directory, { metadataKind, recursive }] of desired) {
					if (watchers.has(directory) || !(await isDirectory(directory))) continue;
					const watcher = watchAdapter.watch(
						directory,
						recursive,
						(event, filename) => {
							const changed = path.resolve(
								filename === null ? directory : path.join(directory, filename),
							);
							if (metadataKind && filename !== null) {
								const name = path.basename(changed);
								const relevant =
									metadataKind === "build"
										? isPackageMetadataFile(name)
										: name === "package.json" || name === "dist";
								if (!relevant) return;
							}
							const requiresRestart = restartRoots.some((root) => isInside(root, changed));
							onChange(
								requiresRestart ? { kind: "restart", changedPath: changed } : { kind: "rebuild" },
							);
							if (metadataKind || event === "rename") queueRefresh();
						},
						(error) => onChange({ kind: "error", error }),
					);
					watchers.set(directory, { metadataKind, recursive, watcher });
				}
			};

			const queueRefresh = () => {
				refreshQueue = refreshQueue.then(refresh, refresh).catch((error: unknown) => {
					onChange({ kind: "error", error });
				});
			};

			// The first pass installs watchers for control metadata; the second
			// reconciles changes that landed before those watchers existed.
			await refresh();
			await refresh();
			return {
				async close() {
					closed = true;
					await refreshQueue;
					for (const { watcher } of watchers.values()) watcher.close();
					watchers.clear();
				},
			};
		},
	};
}
