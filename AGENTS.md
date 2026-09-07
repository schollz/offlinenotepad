# Offline Notepad contributor guide

## System shape

- Keep deployment as one Go binary. Frontend output belongs in `internal/site/build` and is embedded by `internal/site/assets.go`.
- Keep the backend-neutral contract in `internal/database`. SQL changes must be paired in PostgreSQL and SQLite migrations and query files, followed by `make generate`.
- PostgreSQL is selected only by `DATABASE_URL`; SQLite is the standalone fallback.
- Keep bbolt parsing isolated to `internal/legacy`. During the migration window, the server may expose staged legacy ciphertext through the bounded read-only migration route. Legacy decryption stays in the browser during normal application use and must not enter synchronization handling; the explicitly requested, local `migrate-legacy` CLI workflow is the only diagnostic/conversion exception.

## Security invariants

- Passwords, master keys, authentication private keys, and plaintext private notes must never cross the browser boundary during normal application use or appear in logs. When the user explicitly requests it, the local `migrate-legacy` CLI may transiently process a legacy password and plaintext solely for a read-only diagnostic or credentialed conversion; it must not print, log, or retain them.
- Private WebSocket broadcasts contain encrypted records only. Publishing is the sole deliberate plaintext server operation.
- Preserve strict WebSocket origin checks, bounded bodies/messages, security headers, server timeouts, optimistic revisions, and permanent tombstones.
- Do not add password recovery, escrow, cursor presence, invitations, roles, or public collaboration.
- Optional analytics must use the first-party `/api/v1/analytics` relay only. Never load third-party analytics JavaScript, accept arbitrary event properties, identify a workspace/user, or send notebook names, document/public IDs, note metadata or content, search terms, ciphertext, credentials, keys, or raw errors.
- Changes to normalization, Argon2id, HKDF labels, authenticated data, envelope fields, or signatures require matching Go and TypeScript golden tests.
- Never inspect, modify, commit, or log `.env`. Never directly inspect, modify, commit, or log a real `data.db` or its raw records. When the user explicitly requests a legacy migration or diagnostic, the existing `offlinenotepad -migrate`, `offlinenotepad stage-legacy`, or `offlinenotepad migrate-legacy` workflow may open a specifically named real `data.db` read-only through `internal/legacy`; expose only aggregate results and bounded errors, never ciphertext, plaintext notes, credentials, or keys.

## Frontend invariants

- Save encrypted data to the `offlinenotepad-v2` IndexedDB namespace before attempting network synchronization.
- Keep “Saved offline” distinct from “Synced.” Preserve unsent conflicts as timestamped local copies.
- Public notes are explicit snapshots and must never follow private edits automatically.
- Maintain keyboard focus visibility, reduced-motion behavior, semantic labels, responsive mobile navigation, and system/light/dark themes.
- The service worker may cache the app shell and fingerprinted assets, but not APIs, health checks, WebSockets, or public snapshots.

## Version control

- Use Git directly for all version-control operations, including status, diffs, branches, commits, and pushes. Never use GitButler or its `but` CLI.
- Write semantic commit messages using Conventional Commit prefixes such as `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, and `chore:`.

## Before handing off

Run `make frontend`, `make test`, `make lint`, `make test-race`, and a CGO-free production build. When PostgreSQL is available, set `TEST_DATABASE_URL` and run the storage integration test. Do not commit unless the user explicitly requests it.
