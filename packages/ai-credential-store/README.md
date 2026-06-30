# ai-credential-store

A generic, typed key-value store backed by a single JSON file on disk. Built for small amounts of sensitive data (credentials, OAuth tokens, API keys), its value is the disk-I/O hard parts: atomic writes, cross-process locking, secure file permissions, and file watching.

This package is part of the [`ai-lib`](../../README.md) monorepo and is a **standalone leaf**: it imports nothing from `ai-config`, `ai-provider-bridge`, or any host application, and no sibling depends on it. Its only runtime dependencies are `chokidar` (watching) and `proper-lockfile` (locking).

**The store owns where and how bytes hit disk; it does not own credential meaning.** Values are fully generic — callers supply their own types at each call site — so the store has zero knowledge of what it holds.

## Usage

```ts
import { SingleFileStore } from "ai-credential-store";

const store = new SingleFileStore(
  { filePath: "/abs/path/to/store.json" }, // caller chooses the path; the store owns no default
  logger, // optional { debug, warn }
);

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

| Export                  | Kind  | Notes                                         |
| ----------------------- | ----- | --------------------------------------------- |
| `SingleFileStore`       | class | `constructor(config, logger?)`; methods above |
| `SingleFileStoreConfig` | type  | `{ filePath: string }` (absolute path)        |
| `LoggerLike`            | type  | `{ debug(...), warn(...) }`                   |
| `Disposable`            | type  | `{ dispose(): void }` (returned by `watch`)   |

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
