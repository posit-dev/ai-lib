# ai-provider-bridge

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

`ai-provider-bridge` is a platform-neutral package that provides LLM provider infrastructure for Posit Assistant. It owns the plugin registry, model clients for 14 providers, credential abstractions, and a Positron VS Code integration layer. It is consumed by multiple host applications (Positron extension, standalone Node server, RStudio, TUI, Desktop) but depends on none of them.

### Project Structure

```
ai-provider-bridge/
├── src/
│   ├── model-clients/       # ModelClient implementations (one per provider)
│   ├── model-capabilities/  # Per-provider capability inference helpers
│   ├── providers/           # register*Provider() modules + ProviderRegistry class
│   ├── positron/            # VS Code integration (/positron entrypoint)
│   ├── types.ts             # PROVIDER_IDS, credential types, ProviderId
│   ├── provider-map.ts      # PROVIDER_MAP (provider ID -> Positron auth config)
│   ├── local-providers.ts   # LocalProviderManager (Ollama, LM Studio)
│   ├── custom-headers.ts    # Header merging/filtering for customHeaders
│   └── index.ts             # Root entrypoint exports
├── memory-bank/             # Architectural documentation
├── docs/                    # HTML explainer
└── dist/                    # Build output (gitignored)
```

## Quick Reference

### Entrypoints

| Entrypoint | What it provides | vscode dep? |
|---|---|---|
| `ai-provider-bridge` | ProviderRegistry, interfaces, types, cached model fetcher, provider map, LocalProviderManager | No |
| `ai-provider-bridge/providers` | `register*Provider()` functions, all client classes | No |
| `ai-provider-bridge/providers-external` | Minimal provider set (Posit AI only, for OSS/external builds) | No |
| `ai-provider-bridge/positron` | PositronCredentialProvider, VscodeLmClient, message conversion utilities | **Yes** |

### Key Invariants

- Root entrypoint must NOT import `vscode` -- only `/positron` may
- This package must NOT depend on any consumer package -- the dependency arrow is one-way inward
- External builds alias `providers.ts`, `types.ts`, and `local-providers.ts` to `-external` variants (positai only)

### Internal/External Build Variants

External builds alias provider files to their `-external` variants via the consuming application's build configuration:

- `providers.ts` -> `providers-external.ts` -- only Posit AI provider (keeps non-positai provider code and SDK dependencies out of the bundle)
- `types.ts` -> `types-external.ts` -- only positai provider ID and notification actions
- `local-providers.ts` -> `local-providers-external.ts` -- empty `LOCAL_PROVIDER_IDS` and no-op `LocalProviderManager`

## Key Commands

```bash
npm install
npm run build           # esbuild + declaration emit
npm run build:unbundled # tsc only (for debugging)
npm run check-types     # tsc --noEmit
npm run test            # vitest
npm run test:watch      # vitest watch mode
npm run clean           # remove dist/ and build artifacts
```

## Architecture Principles

- Modules should expose minimal APIs
- Minimize shared state between modules
- Maintain clear interfaces and boundaries between modules
- Prefer dependency injection over direct imports of platform services
- The package is a leaf dependency -- it must never import from consumer packages

### Platform Boundary

The `/positron` entrypoint is the only place where `vscode` may be imported. All other code must be platform-neutral. If a feature needs platform-specific behavior, use dependency injection (see `LocalProviderManager` for the pattern).

## Code Guidelines

### TypeScript

- Strict typing is very important. Never cast types `as` unless absolutely necessary.
- Use creative solutions to achieve strict typing rather than escaping with casts.

### Provider Implementation

When adding a new provider:
1. Add the provider ID to `PROVIDER_IDS` in `src/types.ts`
2. Create a client class in `src/model-clients/`
3. Create a provider module in `src/providers/`
4. Export from `src/providers.ts`
5. If it needs Positron auth, add to `PROVIDER_MAP` in `src/provider-map.ts`

See `memory-bank/providerGuide.md` for the full step-by-step guide.

### Custom Headers

New providers must support `customHeaders` from `ApiKeyCredentials`. The merging behavior varies by path:
- **Model discovery**: additive only, provider headers win on collision
- **Direct-SDK chat**: `customHeaders` clobbers on collision (passed last to SDK `headers` option)
- **OpenAI-compatible fetch**: additive only, SDK headers win on collision

See `src/custom-headers.ts` for shared utilities.

## Memory Bank

The `memory-bank/` directory contains architectural documentation with YAML frontmatter (`title`, `description`). Read relevant documents before making significant changes:

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

- **Start with Quick Reference** -- The Quick Reference section provides essential context for most tasks
- **Read selectively** -- Read Memory Bank files when you need deeper context on specific topics
- **Platform boundary** -- Never import `vscode` outside of `src/positron/`
- **Dependency direction** -- Consumer packages depend on this package, never the reverse
