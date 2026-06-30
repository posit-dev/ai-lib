# Shape Guards

Compile-time assertions that keep `ai-config`'s vocabulary compatible with `ai-provider-bridge` **without an import edge** between the two packages.

`shape-guard.typecheck.ts` is type-checked but never emitted. A build error there means the two packages' vocabularies have diverged. The active guards are:

- **Provider IDs** — `BUILTIN_PROVIDER_IDS` (ai-config) exactly matches `PROVIDER_IDS` (bridge).
- **Model-override fields** — `MODEL_METADATA_FIELD_NAMES` (ai-config) ⊆ `keyof ModelInfo` (bridge). Routing-only fields like `baseUrl` are intentionally excluded.
- **Protocols** — `PROTOCOL_VALUES` (ai-config) ⊆ `Protocol` (bridge).
- **Client kinds** — every `CLIENT_KIND_VALUES` entry (ai-config) resolves to a built-in provider id, either directly (identity) or via a non-identity mapping (`aws` → `bedrock`, `snowflake` → `snowflake-cortex`) maintained in the bridge's `ProviderRegistry`.

## Running

Run from the repo root as part of `npm run check-types`, or directly:

```bash
tsc -p typechecks/tsconfig.json
```

`tsconfig.json` aliases `ai-config` and `ai-provider-bridge` to their `src/index.ts`, so the guard checks current source (no build step required). It is also intended to run on every PR to either package, so vocabulary divergence is caught at build time.

## Adding a provider / protocol / client kind

A change to the shared vocabulary in one package fails the guard until the other is updated. Add the matching entry to both `ai-config` and `ai-provider-bridge` (see the bridge's `memory-bank/providerGuide.md`).
