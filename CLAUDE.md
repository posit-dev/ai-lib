# ai-lib

This file provides guidance to AI agents working in the `ai-lib` repository (GitHub: `posit-dev/ai-provider-bridge`).

## Project Overview

`ai-lib` is an **npm-workspaces monorepo** of three independent, platform-neutral packages that together provide the LLM provider infrastructure for Posit Assistant. None of them depends on any host application — the dependency arrow points one way, inward.

The repo is consumed as a **git submodule** (`packages/ai-lib`) by the Posit Assistant monorepo, where all three packages are built from source as workspaces (resolved via `"<pkg>": "*"`), not installed from published tarballs.

| Package              | Purpose                                                                                                                                                                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ai-provider-bridge` | LLM provider infra: plugin registry, model clients (14 providers), credential abstractions, and a Positron VS Code layer                                                                                                                                                               |
| `ai-config`          | `~/.posit/ai/providers.json` schema, validation, defaults, and the load → enforce → build → watch resolution pipeline; also owns shared model metadata: the capability tables and `inferModelCapabilities` (a deliberate charter expansion beyond providers.json handling — see below) |
| `ai-credentials`     | Credential resolution: browser-safe types/shaping, a generic single-file KV store, the store-backed backend + on-disk format, a vscode backend, and a root resolver (device-flow/refresh)                                                                                              |

### Dependency relationships

- `ai-provider-bridge` depends on `ai-config` and `ai-credentials` (`"ai-config": "*"`, `"ai-credentials": "*"`, resolve to workspaces) so both build first.
- `ai-config` and `ai-credentials` are standalone leaves — neither depends on a sibling.
- `ai-config` must never import `ai-provider-bridge` (or any sibling); the bridge imports `ai-config` freely (types, capability helpers). The **vocabulary constants** (provider IDs, protocols, client kinds) remain duplicated on each side — never imported across — so a bridge type change cannot silently alter the disk format; the shape guard in `typechecks/` keeps them in sync (see [Shape Guard](#shape-guard-cross-package-vocabulary-compatibility)).

### Project Structure

```
ai-lib/
├── packages/
│   ├── ai-provider-bridge/   # LLM provider infra (esbuild-bundled; vscode peer dep)
│   ├── ai-config/            # providers.json schema + resolution pipeline (zod)
│   └── ai-credentials/  # generic typed single-file KV store
├── typechecks/               # cross-package compile-time shape guards (ai-config ↔ ai-provider-bridge)
├── memory-bank/              # repo-wide architectural documentation
├── .github/workflows/        # ci.yml, release.yml
├── tsconfig.base.json        # shared compiler options
└── package.json              # workspace root (name: "ai-lib")
```

`ai-provider-bridge` internal layout:

```
packages/ai-provider-bridge/src/
├── model-clients/       # ModelClient implementations (one per provider)
├── model-capabilities/  # Gemini Interactions API allowlist (capability tables live in ai-config)
├── providers/           # register*Provider() modules + ProviderRegistry class
├── positron/            # VS Code integration (/positron entrypoint)
├── types.ts             # PROVIDER_IDS, credential types, ProviderId
├── provider-map.ts      # PROVIDER_MAP (provider ID -> Positron auth config)
├── credential-shaping.ts # Pure shapeCredentials (browser-safe entrypoint)
├── local-providers.ts   # LocalProviderManager (Ollama, LM Studio)
├── custom-headers.ts    # Header merging/filtering for customHeaders
└── index.ts             # Root entrypoint exports
```

## Quick Reference

### Package entrypoints

**`ai-provider-bridge`**

| Entrypoint                              | What it provides                                                                                                                          | vscode dep? |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| `ai-provider-bridge`                    | ProviderRegistry, interfaces, types, cached model fetcher, provider map, LocalProviderManager                                             | No          |
| `ai-provider-bridge/providers`          | `register*Provider()` functions, all client classes                                                                                       | No          |
| `ai-provider-bridge/positron`           | VscodeLmClient, message conversion utilities (PositronCredentialProvider removed — credentials now resolve via `ai-credentials/positron`) | **Yes**     |
| `ai-provider-bridge/credential-shaping` | Compat re-export of `ai-credentials/types` (`shapeCredentials()` + `CredentialConfig`); the implementation now lives in `ai-credentials`  | No          |

**`ai-config`**

| Entrypoint                        | What it provides                                                                                                                             | Node FS dep? |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `ai-config`                       | Vocabulary, Zod schemas, inferred types, defaults, pure resolution helpers, model capability tables, and `inferModelCapabilities`            | No           |
| `ai-config/node`                  | The pure entry plus filesystem seams: `loadResolvedProviderCatalog`, `mutateProvidersConfig`, `watchResolvedProviderCatalog`, path constants | Yes          |
| `ai-config/providers.schema.json` | Generated JSON Schema for editor validation/autocomplete of `providers.json`                                                                 | No           |

**`ai-credentials`**

| Entrypoint                     | What it provides                                                                                                                                                                                                                                      | Platform dep? |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `ai-credentials`               | Root resolver: `CredentialProvider` interface, injected `Backend` seam, `createCredentialProvider()` (root-owned OAuth device-flow + refresh). Imports only `/types` — never `/store`, `vscode`, or an SDK                                            | No            |
| `ai-credentials/types`         | Browser-safe credential types (`ProviderCredentials`), `shapeCredentials()`, `AuthProviderMapping`, OAuth protocol/runtime types (`DeviceAuthInfo`/`TokenData`), custom-provider `clientKind → authMethodId` descriptors, `storageKeyFor()`, `Logger` | No            |
| `ai-credentials/store`         | Generic type-parametric `SingleFileStore` (`get<T>`/`set<T>`) plus `SingleFileStoreConfig` / `LoggerLike` / `Disposable` types. No sibling imports (not even `/types`)                                                                                | fs            |
| `ai-credentials/store-backend` | Store-backed backend (`createStoreBackend`): `StoredProviderCredentials` + tolerant Zod schema (on-disk format), env resolver + `PROVIDER_ENV_MAPPINGS`, `store → env → null` resolution. No `@assistant/*` import                                    | fs            |
| `ai-credentials/positron`      | vscode.authentication backend (`createPositronBackend` + `createVscodeCredentialConfig`)                                                                                                                                                              | **vscode**    |

### Key Invariants

- `ai-provider-bridge` root entrypoint must NOT import `vscode` -- only `/positron` may.
- No package may depend on a consumer (host) package -- the dependency arrow is one-way inward.
- `ai-config` splits pure logic (`ai-config`) from filesystem I/O (`ai-config/node`); the pure entry must stay free of Node FS APIs.
- `ai-config` must never import `ai-provider-bridge` (or any sibling); the bridge imports `ai-config` freely (types, capability helpers). The vocabulary constants remain duplicated on each side — never imported across — so a bridge type change cannot silently alter the disk format; the shape guard in `typechecks/` keeps them in sync.
- `ai-credentials`: `/types` stays browser-safe (no `vscode`/SDK/Node-builtins); `/store` imports no sibling; the root never imports `/store` (backends are injected); `/store-backend` never imports `@assistant/*`. `/store-backend` and `/positron` are the platform-bound (fs/vscode) entries.
- `ai-credentials`'s `providerEnvMappings.ts` has a `-external` variant (empty map — positai has no secret env vars), redirected by the consuming app's build config.

## Key Commands

Run from the repo root; npm workspaces fan out to each package:

```bash
npm install            # install all workspaces
npm run build          # build all packages (ai-config builds before ai-provider-bridge)
npm run check-types    # per-package tsc --noEmit + the cross-package shape guard (typechecks/)
npm run test           # vitest across all packages
npm run lint           # lint across packages
npm run format         # oxfmt
npm run format:check   # oxfmt --check
```

Target a single workspace with `-w`, e.g. `npm run build -w ai-provider-bridge`, `npm test -w ai-config`, `npm run check-types -w ai-credentials`.

Per-package build notes:

- **`ai-provider-bridge`**: `npm run build` runs esbuild bundling + declaration emit; `npm run build:unbundled` is tsc-only (debugging); `npm run watch` runs the esbuild + dts watchers.
- **`ai-config`**: plain `tsc -p .`, with a `prebuild` that regenerates `providers.schema.json` from the Zod schemas (`npm run generate-schema`).
- **`ai-credentials`**: plain `tsc -p .`. Multi-entrypoint: root (resolver + factory), `/types` (browser-safe credentials + shaping + vocab), `/store` (generic SingleFileStore), `/store-backend` (store-backed backend + disk format), `/positron` (vscode backend). `vscode` is an optional peer (typed via `@types/vscode`); `/positron` never loads outside Positron.

### Shape Guard (cross-package vocabulary compatibility)

`typechecks/shape-guard.typecheck.ts` holds compile-time-only assertions (type-checked, never emitted) that keep `ai-config`'s vocabulary compatible with `ai-provider-bridge` **without an import edge** between them:

- `BUILTIN_PROVIDER_IDS` (ai-config) exactly matches `PROVIDER_IDS` (bridge)
- model-override metadata field names (ai-config) ⊆ `ModelInfo` keys (bridge)
- `PROTOCOL_VALUES` ⊆ `Protocol`; `CLIENT_KIND_VALUES` map onto provider IDs (allowing the non-identity mappings `aws` → `bedrock`, `snowflake` → `snowflake-cortex`)

It runs as part of the root `npm run check-types` (`tsc -p typechecks/tsconfig.json`, which aliases both packages to their `src/index.ts`). Adding or renaming a provider/protocol/client-kind in one package fails the typecheck until the other is updated.

### Internal/External Build Variants

`ai-config`'s `buildCatalog()` accepts `external: true` to skip `providers.custom` entries (whose client code is aliased away in external bundles).

## Releasing

### Distribution model (locked — plan `2026-07-01-0046`, Phase 8)

**Consumers build all three packages from source as workspaces, pinned via the git submodule.** There is no install from a registry, and `ai-config`/`ai-credentials` are **not** published as tarballs.

- **Notebooks (and any other standalone consumer)** depends on `ai-provider-bridge`, `ai-config`, and `ai-credentials` directly, consuming `ai-lib` as a **git submodule + npm workspace** — the same model the Posit Assistant monorepo uses. It imports nothing from `@assistant/*`. Adding this repo as a submodule and listing the three packages as `"*"` workspace deps is the supported path.
- **The packed `ai-provider-bridge` tarball bundles-in `ai-config`/`ai-credentials` runtime code** (esbuild inlines them — they are intentionally absent from `esbuild.config.ts`'s `external` list), so the bridge's `dist/` is self-contained at runtime. This is the **bundle-in** decision (not also-pack): the tarball stays bridge-only. Caveat: the tarball still declares `"ai-config": "*"` / `"ai-credentials": "*"` deps and its `.d.ts` files reference those type packages, so the tarball is **not** a standalone registry install — it is a secondary artifact, and direct source/submodule consumption is the supported path.

### Cutting a bridge release

A **tag-driven** GitHub Release publishes the `ai-provider-bridge` tarball. Pushing a tag matching `v*` triggers `.github/workflows/release.yml`, which runs `npm ci` -> `npm run build -w ai-provider-bridge` -> `npm pack -w ai-provider-bridge` and creates (or updates) a GitHub Release with the `.tgz` attached. Only `ai-provider-bridge` is packed (per the bundle-in decision above).

To cut a release (example bumps `ai-provider-bridge` to `0.0.11`):

```bash
# 1. Bump the package version (updates packages/ai-provider-bridge/package.json + the lockfile)
npm version 0.0.11 -w ai-provider-bridge --no-git-tag-version

# 2. Commit the bump using the "Version X.Y.Z" convention
git add packages/ai-provider-bridge/package.json package-lock.json
git commit -m "Version 0.0.11"

# 3. Tag and push (the tag push is what triggers the Release workflow)
git tag v0.0.11
git push origin main
git push origin v0.0.11
```

Notes:

- The **tag push is the trigger** -- pushing `main` alone does not create a release.
- Release notes are auto-generated via `gh release create --generate-notes`, which lists PRs
  merged since the previous tag plus a Full Changelog compare link. Notes are generated only on
  the **create** path; if the tag's release already exists, the workflow re-uploads the tarball
  with `--clobber` and does not regenerate notes.
- Because notes are built from merged PRs, land changes via PRs so they appear as line items.
- Verify after pushing with `gh run watch` or `gh release view v0.0.11`.

## Architecture Principles

- Modules should expose minimal APIs
- Minimize shared state between modules
- Maintain clear interfaces and boundaries between modules
- Prefer dependency injection over direct imports of platform services
- Each package is a leaf relative to host applications -- none may import a consumer package

### Platform Boundary (`ai-provider-bridge`)

The `/positron` entrypoint is the only place where `vscode` may be imported. All other bridge code must be platform-neutral. If a feature needs platform-specific behavior, use dependency injection (see `LocalProviderManager` for the pattern). `vscode` is the package's only (optional) peer dependency.

## Code Guidelines

### TypeScript

- Strict typing is very important. Never cast types `as` unless absolutely necessary.
- Use creative solutions to achieve strict typing rather than escaping with casts.

### Provider Implementation (`ai-provider-bridge`)

When adding a new provider:

1. Add the provider ID to `PROVIDER_IDS` in `src/types.ts`
2. Create a client class in `src/model-clients/`
3. Create a provider module in `src/providers/`
4. Export from `src/providers.ts`
5. If it needs Positron auth, add to `PROVIDER_MAP` in `src/provider-map.ts`
6. Add the matching ID to `BUILTIN_PROVIDER_IDS` in `ai-config` so the shape guard passes
7. If the provider needs capability inference, add its table to `ai-config/src/model-capabilities/` and wire it into `inferModelCapabilities` (the tables live in `ai-config`, not the bridge)

See `memory-bank/providerGuide.md` for the full step-by-step guide.

### Custom Headers (`ai-provider-bridge`)

New providers must support `customHeaders` from `ApiKeyCredentials`. The merging behavior varies by path:

- **Model discovery**: additive only, provider headers win on collision
- **Direct-SDK chat**: `customHeaders` clobbers on collision (passed last to SDK `headers` option)
- **OpenAI-compatible fetch**: additive only, SDK headers win on collision

See `src/custom-headers.ts` for shared utilities.

## Memory Bank

The `memory-bank/` directory is a **single, repo-wide** documentation set covering all three packages in this monorepo (`ai-provider-bridge`, `ai-config`, `ai-credentials`). Each file has YAML frontmatter with `title`, `description`, and a `package` field naming which package it documents (so a reader can tell scope at a glance). Read relevant documents before making significant changes:

**`ai-provider-bridge`**

- `./memory-bank/architecture.md`
  - Package architecture, entrypoints, invariants, code layout
  - Credential system and custom headers precedence rules
  - VS Code Language Model (vscode.lm) integration

- `./memory-bank/providerGuide.md`
  - Step-by-step guide for adding new providers
  - Implementation patterns (AI SDK, OpenAI-compatible, custom)
  - Thinking/reasoning support
  - Custom headers integration

- `./memory-bank/geminiInteractions.md`
  - Gemini Interactions API: stateful chaining, unsigned-reasoning filtering, API gotchas

**`ai-config`**

- `./memory-bank/aiConfig.md`
  - The `providers.json` schema, vocabulary, and defaults
  - The load → enforce → build → watch resolution pipeline
  - File I/O seams (load/mutate/watch) and the bridge vocabulary shape guard

**`ai-credentials`**

- `./memory-bank/aiCredentialStore.md`
  - The generic typed single-file KV store (`SingleFileStore`)
  - Atomic writes, cross-process locking, secure permissions, file watching

## Planning Files

When creating planning documents for complex tasks:

### File Naming

Use the format: `plans/{yyyy-mm-dd}-{hhmm}-{plan_title}.md`

Example: `plans/2026-05-26-1400-add-vertex-provider.md`

### File Structure

Plan files should include:

1. **Overview**: Brief description of the plan's goals and context
2. **Checklist**: A markdown checklist of all work items using `- [ ]` syntax
3. **Details**: Additional context, design decisions, or implementation notes as needed

### Maintaining Progress

As you work through a plan:

1. Update the plan file after completing each work item
2. Check off items by changing `- [ ]` to `- [x]`
3. Keep the plan file current
4. Add new items if you discover additional work during implementation

## Key Reminders

- **Start with Quick Reference** -- it provides essential context for most tasks
- **Read selectively** -- read Memory Bank files when you need deeper context on a specific package
- **Platform boundary** -- never import `vscode` outside `ai-provider-bridge`'s `src/positron/`
- **Dependency direction** -- host applications depend on these packages, never the reverse
- **Shape guard** -- changing the provider/protocol/client-kind vocabulary requires updating both `ai-config` and `ai-provider-bridge`
