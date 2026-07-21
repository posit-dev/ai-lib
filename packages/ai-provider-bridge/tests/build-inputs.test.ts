/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createBuildInputs,
	createBuildInputsWithAdapter,
	type BuildInputChange,
	type BuildInputWatchAdapter,
} from "../scripts/build-inputs";

const temporaryDirectories: string[] = [];

interface BuildInputFixture {
	bridgeDir: string;
	dependencyDist: string;
	root: string;
}

interface FakeWatchRegistration {
	active: boolean;
	directory: string;
	onChange: (event: "change" | "rename", filename: string | null) => void;
	recursive: boolean;
}

class FakeWatchAdapter implements BuildInputWatchAdapter {
	private readonly registrations: FakeWatchRegistration[] = [];

	private covers(registration: FakeWatchRegistration, changedPath: string): boolean {
		const relative = path.relative(registration.directory, changedPath);
		const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
		return (
			registration.active &&
			inside &&
			(registration.recursive || path.dirname(changedPath) === registration.directory)
		);
	}

	watch(
		directory: string,
		recursive: boolean,
		onChange: (event: "change" | "rename", filename: string | null) => void,
		_onError: (error: unknown) => void,
	) {
		const registration = { active: true, directory, onChange, recursive };
		this.registrations.push(registration);
		return { close: () => (registration.active = false) };
	}

	change(changedPath: string): void {
		for (const registration of this.registrations) {
			if (this.covers(registration, changedPath)) {
				registration.onChange("change", path.relative(registration.directory, changedPath));
			}
		}
	}

	isWatching(changedPath: string): boolean {
		return this.registrations.some((registration) => this.covers(registration, changedPath));
	}
}

async function createFixture(): Promise<BuildInputFixture> {
	const root = await mkdtemp(path.join(os.tmpdir(), "bridge-build-inputs-"));
	temporaryDirectories.push(root);
	const bridgeDir = path.join(root, "packages", "bridge");
	const dependencyDir = path.join(root, "packages", "workspace-dependency");
	const dependencyDist = path.join(dependencyDir, "dist");
	await Promise.all([
		mkdir(path.join(bridgeDir, "src"), { recursive: true }),
		mkdir(path.join(bridgeDir, "scripts"), { recursive: true }),
		mkdir(dependencyDist, { recursive: true }),
	]);
	await Promise.all([
		writeFile(path.join(root, "package.json"), JSON.stringify({ private: true })),
		writeFile(
			path.join(root, "tsconfig.base.json"),
			JSON.stringify({ compilerOptions: { target: "ES2022" } }),
		),
		writeFile(
			path.join(bridgeDir, "package.json"),
			JSON.stringify({
				name: "bridge",
				dependencies: { "workspace-dependency": "*", external: "^1.0.0" },
			}),
		),
		writeFile(
			path.join(bridgeDir, "tsconfig.json"),
			JSON.stringify({ extends: "../../tsconfig.base.json" }),
		),
		writeFile(path.join(bridgeDir, "src", "index.ts"), "export const value = 1;\n"),
		writeFile(path.join(bridgeDir, "scripts", "build.ts"), "export {};\n"),
		writeFile(
			path.join(dependencyDir, "package.json"),
			JSON.stringify({ name: "workspace-dependency" }),
		),
		writeFile(path.join(dependencyDist, "index.js"), "export const dependency = 1;\n"),
	]);
	return { bridgeDir, dependencyDist, root };
}

function nextChange(
	startWatching: (
		onChange: (change: BuildInputChange) => void,
	) => Promise<{ close(): Promise<void> }>,
	matches: (change: BuildInputChange) => boolean = () => true,
): Promise<{ change: Promise<BuildInputChange>; close(): Promise<void> }> {
	let resolveChange!: (change: BuildInputChange) => void;
	const change = new Promise<BuildInputChange>((resolve) => {
		resolveChange = resolve;
	});
	return startWatching((observed) => {
		if (matches(observed)) resolveChange(observed);
	}).then((watcher) => ({ change, close: () => watcher.close() }));
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
	return await Promise.race([
		promise,
		new Promise<never>((_resolve, reject) => {
			setTimeout(() => reject(new Error("Timed out waiting for a build-input change")), 2_000);
		}),
	]);
}

afterEach(async () => {
	await Promise.all(
		temporaryDirectories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("bridge build inputs", () => {
	it("discovers package configs, ancestor configs, scripts, and workspace output automatically", async () => {
		const { bridgeDir, dependencyDist, root } = await createFixture();
		const inputs = createBuildInputs(bridgeDir);
		let previous = await inputs.snapshot();

		const changes: ReadonlyArray<readonly [string, string]> = [
			[
				path.join(bridgeDir, "tsconfig.json"),
				'{"compilerOptions":{"useDefineForClassFields":false}}',
			],
			[path.join(root, "tsconfig.base.json"), '{"compilerOptions":{"target":"ESNext"}}'],
			[path.join(bridgeDir, "scripts", "build.ts"), "export const buildVersion = 2;\n"],
			[path.join(dependencyDist, "index.js"), "export const dependency = 2;\n"],
			[path.join(bridgeDir, "tsconfig.additional.json"), '{"compilerOptions":{}}'],
		];
		for (const [file, contents] of changes) {
			await writeFile(file, contents);
			const current = await inputs.snapshot();
			expect(current).not.toBe(previous);
			previous = current;
		}

		await writeFile(path.join(bridgeDir, "README.md"), "not a build input\n");
		expect(await inputs.snapshot()).toBe(previous);
	});

	it("watches automatically discovered workspace output", async () => {
		const { bridgeDir, dependencyDist } = await createFixture();
		const watchAdapter = new FakeWatchAdapter();
		const inputs = createBuildInputsWithAdapter(bridgeDir, watchAdapter);
		const watcher = await nextChange((onChange) => inputs.watch(onChange));
		try {
			watchAdapter.change(path.join(dependencyDist, "index.js"));
			await expect(withTimeout(watcher.change)).resolves.toEqual({ kind: "rebuild" });
		} finally {
			await watcher.close();
		}
	});

	it("requires a coordinator restart when its build scripts change", async () => {
		const { bridgeDir } = await createFixture();
		const watchAdapter = new FakeWatchAdapter();
		const inputs = createBuildInputsWithAdapter(bridgeDir, watchAdapter);
		const watcher = await nextChange(
			(onChange) => inputs.watch(onChange),
			(change) => change.kind === "restart",
		);
		try {
			const changedScript = path.join(bridgeDir, "scripts", "build.ts");
			watchAdapter.change(changedScript);
			await expect(withTimeout(watcher.change)).resolves.toEqual({
				kind: "restart",
				changedPath: changedScript,
			});
		} finally {
			await watcher.close();
		}
	});

	it("adds watch coverage when package metadata introduces a workspace dependency", async () => {
		const { bridgeDir, root } = await createFixture();
		const watchAdapter = new FakeWatchAdapter();
		const inputs = createBuildInputsWithAdapter(bridgeDir, watchAdapter);
		const watcher = await inputs.watch(() => {});
		try {
			const addedDependency = path.join(root, "packages", "added-dependency");
			const addedOutput = path.join(addedDependency, "dist", "index.js");
			await mkdir(path.dirname(addedOutput), { recursive: true });
			await Promise.all([
				writeFile(
					path.join(addedDependency, "package.json"),
					JSON.stringify({ name: "added-dependency" }),
				),
				writeFile(addedOutput, "export const added = true;\n"),
			]);
			const bridgePackage = path.join(bridgeDir, "package.json");
			await writeFile(
				bridgePackage,
				JSON.stringify({
					name: "bridge",
					dependencies: {
						"added-dependency": "workspace:*",
						"workspace-dependency": "*",
					},
				}),
			);
			watchAdapter.change(bridgePackage);

			await vi.waitFor(() => expect(watchAdapter.isWatching(addedOutput)).toBe(true));
		} finally {
			await watcher.close();
		}
	});
});
