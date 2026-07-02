# ai-lib

This file provides guidance to AI agents working in the `ai-lib` repository (GitHub: `posit-dev/ai-provider-bridge`).

## Project Overview

`ai-lib` is an **npm-workspaces monorepo** of three independent, platform-neutral packages that together provide the LLM provider infrastructure for Posit Assistant. None of them depends on any host application — the dependency arrow points one way, inward.

The repo is consumed as a **git submodule** (`packages/ai-lib`) by the Posit Assistant monorepo, where all three packages are built from source as workspaces (resolved via `"<pkg>": "*"`), not installed from published tarballs.

| Package              | Purpose                                                                                                                  |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `ai-provider-bridge` | LLM provider infra: plugin registry, model clients (14 providers), credential abstractions, and a Positron VS Code layer |
| `ai-config`          | `~/.posit/genai/providers.json` schema, validation, defaults, and the load → enforce → build → watch resolution pipeline |
| `ai-credentials`     | Generic typed single-file KV store (atomic writes, cross-process locking, secure permissions, file watching)             |

### Dependency relationships

- `ai-provider-bridge` depends on `ai-config` and `ai-credentials` (`"ai-config": "*"`, `"ai-credentials": "*"`, resolve to workspaces) so both build first.
- `ai-config` and `ai-credentials` are standalone leaves — neither depends on a sibling.
- `ai-config` and `ai-provider-bridge` share a vocabulary (provider IDs, protocols, client kinds), but with **no import edge** between them. A compile-time **shape guard** in `typechecks/` keeps them compatible (see [Shape Guard](#shape-guard-cross-package-vocabulary-compatibility)).

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
├── model-capabilities/  # Per-provider capability inference helpers
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

| Entrypoint                              | What it provides                                                                              | vscode dep? |
| --------------------------------------- | --------------------------------------------------------------------------------------------- | ----------- |
| `ai-provider-bridge`                    | ProviderRegistry, interfaces, types, cached model fetcher, provider map, LocalProviderManager | No          |
| `ai-provider-bridge/providers`          | `register*Provider()` functions, all client classes                                           | No          |
| `ai-provider-bridge/providers-external` | Minimal provider set (Posit AI only, for OSS/external builds)                                 | No          |
| `ai-provider-bridge/positron`           | PositronCredentialProvider, VscodeLmClient, message conversion utilities                      | **Yes**     |
| `ai-provider-bridge/credential-shaping` | Pure `shapeCredentials()` + `CredentialConfig` (browser-safe, for Positron's renderer facade) | No          |

**`ai-config`**

| Entrypoint                        | What it provides                                                                                                                             | Node FS dep? |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| `ai-config`                       | Vocabulary, Zod schemas, inferred types, defaults, pure resolution helpers                                                                   | No           |
| `ai-config/node`                  | The pure entry plus filesystem seams: `loadResolvedProviderCatalog`, `mutateProvidersConfig`, `watchResolvedProviderCatalog`, path constants | Yes          |
| `ai-config/providers.schema.json` | Generated JSON Schema for editor validation/autocomplete of `providers.json`                                                                 | No           |

**`ai-credentials`**

| Entrypoint                | What it provides                                                                         |
| ------------------------- | ---------------------------------------------------------------------------------------- |
| `ai-credentials`          | Stub root entry (Phase 4: CredentialProvider interface + factory)                        |
| `ai-credentials/types`    | Browser-safe credential types, `shapeCredentials()`, `AuthProviderMapping`, `Logger`     |
| `ai-credentials/store`    | `SingleFileStore` class plus `SingleFileStoreConfig` / `LoggerLike` / `Disposable` types |
| `ai-credentials/positron` | Stub entry (Phase 4: vscode.authentication backend)                                      |

### Key Invariants

- `ai-provider-bridge` root entrypoint must NOT import `vscode` -- only `/positron` may.
- No package may depend on a consumer (host) package -- the dependency arrow is one-way inward.
- `ai-config` splits pure logic (`ai-config`) from filesystem I/O (`ai-config/node`); the pure entry must stay free of Node FS APIs.
- `ai-config` and `ai-provider-bridge` must not import each other; vocabulary compatibility is enforced by the shape guard.
- External builds alias `ai-provider-bridge`'s `providers.ts`, `types.ts`, and `local-providers.ts` to `-external` variants (positai only).

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
- **`ai-credentials`**: plain `tsc -p .`. Multi-entrypoint: `/types` (browser-safe credentials + shaping), `/store` (SingleFileStore), `/positron` (stub).

### Shape Guard (cross-package vocabulary compatibility)

`typechecks/shape-guard.typecheck.ts` holds compile-time-only assertions (type-checked, never emitted) that keep `ai-config`'s vocabulary compatible with `ai-provider-bridge` **without an import edge** between them:

- `BUILTIN_PROVIDER_IDS` (ai-config) exactly matches `PROVIDER_IDS` (bridge)
- model-override metadata field names (ai-config) ⊆ `ModelInfo` keys (bridge)
- `PROTOCOL_VALUES` ⊆ `Protocol`; `CLIENT_KIND_VALUES` map onto provider IDs (allowing the non-identity mappings `aws` → `bedrock`, `snowflake` → `snowflake-cortex`)

It runs as part of the root `npm run check-types` (`tsc -p typechecks/tsconfig.json`, which aliases both packages to their `src/index.ts`). Adding or renaming a provider/protocol/client-kind in one package fails the typecheck until the other is updated.

### Internal/External Build Variants

External builds alias `ai-provider-bridge` provider files to their `-external` variants via the consuming application's build configuration:

- `providers.ts` -> `providers-external.ts` -- only Posit AI provider (keeps non-positai provider code and SDK dependencies out of the bundle)
- `types.ts` -> `types-external.ts` -- only positai provider ID and notification actions
- `local-providers.ts` -> `local-providers-external.ts` -- empty `LOCAL_PROVIDER_IDS` and no-op `LocalProviderManager`

`ai-config`'s `buildCatalog()` accepts `external: true` to skip `providers.custom` entries (whose client code is aliased away in external bundles).

## Releasing

Consumers pick up changes primarily by **updating the git-submodule pin** (gitlink) in the Posit Assistant monorepo — there is no install from a registry.

Separately, a **tag-driven** GitHub Release publishes an `ai-provider-bridge` tarball. Pushing a tag matching `v*` triggers `.github/workflows/release.yml`, which runs `npm ci` -> `npm run build -w ai-provider-bridge` -> `npm pack -w ai-provider-bridge` and creates (or updates) a GitHub Release with the `.tgz` attached. Only `ai-provider-bridge` is packed; `ai-config` and `ai-credentials` are consumed via the submodule/workspace, not released as tarballs.

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
  - Internal/external build variant details

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
