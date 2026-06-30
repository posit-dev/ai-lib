# ai-credential-store

A generic, typed key-value store backed by a single JSON file on disk. Built for small amounts of sensitive data (credentials, OAuth tokens, API keys), its value is the disk-I/O hard parts: atomic writes, cross-process locking, secure file permissions, and file watching.

This package is part of the [`ai-lib`](../../README.md) monorepo and is a **standalone leaf**: it imports nothing from `ai-config`, `ai-provider-bridge`, or any host application, and no sibling depends on it. Its only runtime dependencies are `chokidar` (watching) and `proper-lockfile` (locking).

**The store owns where and how bytes hit disk; it does not own credential meaning.** Values are fully generic — callers supply their own types at each call site — so the store has zero knowledge of what it holds.

## Usage

### Default path (recommended)

The package owns a canonical default path for Posit AI credential storage: `~/.posit/genai/auth/data.json`.

```ts
import { createDefaultStore, getDefaultStorePath } from "ai-credential-store";

const store = createDefaultStore(logger); // ~/.posit/genai/auth/data.json
const path = getDefaultStorePath(); // inspect the default path
```

### Custom path

For non-default locations (tests, migration stores), use the `SingleFileStore` constructor directly:

```ts
import { SingleFileStore } from "ai-credential-store";

const store = new SingleFileStore(
  { filePath: "/abs/path/to/store.json" },
  logger, // optional { debug, warn }
);
```

### API

```ts
// Typed reads/writes — generics live on the methods, not the class.
await store.set("auth:positai:oauth", { token: "..." });
const creds = await store.get<{ token: string }>("auth:positai:oauth");

await store.keys(); // string[]
await store.delete("auth:positai:oauth");
await store.clear();

// Run a multi-step critical section under a cross-process lock.
await store.withLock(async () => {
  const current = await store.get<Record<string, unknown>>("key");
  await store.set("key", { ...current, updated: true });
});

// React to external changes; dispose to stop.
const sub = store.watch(() => reload());
sub.dispose();
```

Keys are **opaque strings**. A `namespace:key` convention (e.g. `auth:positai:oauth`) is recommended so multiple products can share one file, but the store does not parse or enforce it.

## Guarantees

- **Atomic writes** — writes go to a PID-suffixed temp file and are `rename`d over the target (the OS guarantees the rename is atomic; the PID suffix avoids cross-process collisions).
- **Secure permissions (Unix)** — files written `0o600`, directories created `0o700`; reasserted on read if they drift. Skipped on Windows.
- **Two locking layers** — an in-process write mutex serializes `set`/`delete`/`clear` within a process (not re-entrant), and `withLock(fn)` provides a caller-scoped cross-process lock via `proper-lockfile` (retries, 10s stale timeout to survive crashes).
- **File watching** — `chokidar` with a 200ms debounce and `awaitWriteFinish`, listening to both `change` and `add` so the temp-file+rename pattern is detected reliably; returns a `Disposable`.
- **Corruption tolerance** — invalid JSON logs a warning and is treated as `{}`; the next write replaces it with valid JSON.

## API

| Export                  | Kind     | Notes                                                            |
| ----------------------- | -------- | ---------------------------------------------------------------- |
| `SingleFileStore`       | class    | `constructor(config, logger?)`; methods above                    |
| `createDefaultStore`    | function | `(logger?) → SingleFileStore` at `~/.posit/genai/auth/data.json` |
| `getDefaultStorePath`   | function | `() → string` — canonical default file path                      |
| `SingleFileStoreConfig` | type     | `{ filePath: string }` (absolute path)                           |
| `LoggerLike`            | type     | `{ debug(...), warn(...) }`                                      |
| `Disposable`            | type     | `{ dispose(): void }` (returned by `watch`)                      |

### Method reference

All reads and writes are `async`. Value types are generic per call site — the store itself never sees concrete credential shapes.

#### `get<T>(key): Promise<T | undefined>`

Read a single value. Returns `undefined` if the key is absent. The caller supplies `T`; the store does not validate that the stored bytes match it, so treat `T` as an assertion about what you wrote.

```ts
const oauth = await store.get<{ token: string }>("auth:positai:oauth");
```

#### `keys(): Promise<string[]>`

Return all keys currently in the store (insertion order not guaranteed).

#### `set<T>(key, value): Promise<void>`

Write a value, replacing any existing one. Serialized through the in-process write mutex, so concurrent `set`/`delete`/`clear` calls within a process apply as ordered read-modify-write steps rather than racing. Persisted atomically (temp file + `rename`).

#### `delete(key): Promise<void>`

Remove a key. No-op if absent. Goes through the same write mutex and atomic write as `set`.

#### `clear(): Promise<void>`

Replace the entire store with `{}`. Same write-mutex/atomic-write guarantees.

#### `withLock<T>(fn): Promise<T>`

Run `fn` while holding a **cross-process** lock on the store file, and return its result. The store owns the lock primitive; the **caller chooses the scope** — wrap a whole multi-step critical section (read → compute → write) so another process can't interleave between your steps:

```ts
await store.withLock(async () => {
  const current = (await store.get<Record<string, unknown>>("key")) ?? {};
  await store.set("key", { ...current, updated: true });
});
```

Backed by `proper-lockfile` with stale-lock reclamation (a lock held >10s is considered stale, so a crashed holder can't deadlock the file). Note this is a _different_ layer from the in-process mutex that guards individual writes — `withLock` is what you reach for when a sequence of operations must be atomic across processes.

#### `watch(handler): Disposable`

Invoke `handler` whenever the file changes on disk (e.g. another process wrote it). Returns a `Disposable`; call `.dispose()` to stop. Debounced 200ms and uses chokidar's `awaitWriteFinish`, listening to both `change` and `add` so the temp-file-plus-rename write pattern is detected reliably. The handler takes no arguments — re-read via `get`/`keys` to pick up the new state.

```ts
const sub = store.watch(() => reloadCredentials());
// later:
sub.dispose();
```

## Development

```bash
npm install
npm run build        # tsc -p .
npm run watch        # tsc -p . --watch
npm run check-types  # tsc --noEmit
npm run test         # vitest
npm run test:watch   # vitest watch mode
npm run clean        # remove dist/ and build artifacts
```

## Documentation

See [`memory-bank/aiCredentialStore.md`](../../memory-bank/aiCredentialStore.md) for the full architecture.
