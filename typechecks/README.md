# Shape Guards

Compile-time assertions that keep `ai-config`'s vocabulary compatible with `ai-provider-bridge`.

Guards to be added in Phase 2:

- Model-override field set in `ai-config` ⊆ `ModelInfo` fields in the bridge
- Provider-id list in `ai-config` matches `PROVIDER_IDS` in the bridge
- Protocol and client-kind enums are compatible between the two packages

These run on every PR to either package, so vocabulary divergence is caught at build time.
