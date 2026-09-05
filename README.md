# Offline Notepad

Offline Notepad is a zero-knowledge, offline-first notebook. The browser encrypts notes before they leave the device, saves them to IndexedDB first, and synchronizes encrypted records through one Go server. Markdown and plain text are canonical; public pages are explicit, read-only snapshots.

## Architecture

```text
Browser
  ├─ HTTP GET/POST
  └─ WebSocket autosave and multi-device sync
          ↓
Single Go server
  ├─ renders embedded HTML templates
  ├─ serves embedded Vite assets
  ├─ handles API, public pages, and page rules
  └─ database.Store
          ↓
PostgreSQL when DATABASE_URL is set
SQLite otherwise
```

The production binary embeds `internal/site/build` with `go:embed`. PostgreSQL and SQLite use the same storage contract, paired embedded migrations, handwritten SQL, and sqlc-generated adapters. The server is CGO-free.

## Encryption boundary

Notebook names are normalized with trimming, Unicode NFC, and Unicode case folding, then hashed to a full SHA-256 workspace ID. A browser Web Worker derives a master key with versioned Argon2id parameters. HKDF produces independent XChaCha20-Poly1305 content and deterministic Ed25519 authentication keys.

Each note has a fresh nonce and authenticates its workspace ID and document ID. The server receives only encrypted private notes, ciphertext hashes, revisions, tombstones, KDF metadata, and an authentication public key. WebSockets authenticate by signing a one-time server challenge. Passwords, master keys, private keys, decrypted notes, and plaintext private-note search terms remain in the browser.

There is no account recovery or key escrow. A forgotten password cannot be reset. Password rotation is online and atomic: the browser re-encrypts every active note, rotates the public key, and signs other devices out.

Notebook access uses one **Open notebook** form. Any non-empty name/password pair is accepted: existing credentials open a notebook, staged legacy credentials migrate it, and otherwise a new encrypted notebook is created automatically. After a successful open, the browser saves the derived client keys in IndexedDB and reopens that notebook automatically, including while offline. **Log out** removes that saved login without deleting the locally cached encrypted notes; the password itself is never stored.

Public snapshots are intentionally plaintext. Publishing never tracks later private edits automatically.

## Optional analytics

Set both `UMAMI_URL` and `UMAMI_WEBSITE_ID` to enable privacy-bounded Umami analytics. The browser never loads Umami or other third-party JavaScript: a small first-party helper sends an allowlisted event to `/api/v1/analytics`, and the Go server relays it to Umami's `/api/send` endpoint. Missing or invalid configuration leaves analytics disabled.

Telemetry is limited to normalized route classes and fixed product milestones. Notebook names, workspace/document/public IDs, titles, note contents, search terms, ciphertext, passwords, keys, and raw errors are never accepted by the relay. Standard visitor reporting forwards the validated client IP and browser User-Agent, language, screen dimensions, and a sanitized referrer with queries and fragments removed. The helper respects Do Not Track and Global Privacy Control, keeps Umami's cache token in memory only, and drops offline events without retrying.

## Requirements

- Go 1.26.8
- Node.js 24
- PostgreSQL for production and legacy imports; no database service is needed for SQLite use

## Development

Copy `.env.example` to `.env` and adjust it. `.env` is ignored and must not be committed.

```sh
make frontend-install
make generate
make dev
```

The app listens on port 8251 by default. `make dev` rebuilds the Vite application before restarting Go. For Vite's standalone development server, run `npm --prefix web run dev` and include `http://localhost:5173` in `ALLOWED_ORIGINS`.

Useful commands:

```sh
make frontend       # type-check and produce embedded Vite assets
make generate       # regenerate both sqlc packages
make migrate        # apply embedded migrations
make reset-test-db  # recreate the offlinenotepad_dev PostgreSQL database
make test           # frontend and Go tests
make test-race      # Go race detector
make lint           # TypeScript check and go vet
make build          # optimized CGO-free local binary
make docker         # local production image
```

The binary defaults to `serve`, so these are equivalent:

```sh
./offlinenotepad
./offlinenotepad serve
```

If `DATABASE_URL` is absent, `SQLITE_PATH` defaults to `offlinenotepad.sqlite3`.

For PostgreSQL testing, set `DATABASE_URL` in `.env` or export it with a URL whose database name is exactly `offlinenotepad_dev`, then run `make reset-test-db`. An exported value takes precedence over `.env`. The reset script connects to the same server as the `postgres` maintenance database, force-drops only `offlinenotepad_dev`, and recreates it. It deliberately refuses other database names.

## Legacy bbolt migration

Legacy migration is designed for a hosted `data.db` containing many encrypted accounts. PostgreSQL is required, and the source file is always opened read-only.

Every legacy command first applies or verifies the embedded PostgreSQL schema migrations. The archive-wide command does not require any usernames or passwords.

First validate the complete archive without writing:

```sh
./offlinenotepad -migrate data.db --dry-run
```

Then stage every account, encrypted document, hash, and public snapshot transactionally:

```sh
./offlinenotepad -migrate data.db
```

This command does not request usernames or passwords because the old database does not contain them. It validates the bbolt bucket pairs and ciphertext structure, copies every encrypted record into PostgreSQL, restores safe Markdown/plaintext public snapshots, and reports counts only. Re-running it skips byte-identical staged records; a conflicting record rolls back the entire run.

When an existing user next chooses **Open notebook**, the browser derives the old eight-character account ID from the entered username, downloads that account's staged ciphertext, and reproduces the old CryptoJS AES-CBC/PBKDF2 and LZ-String/UTF-16 decoder locally. Only after every UUID and legacy plaintext hash validates does the browser derive modern Argon2id keys, re-encrypt every note with XChaCha20-Poly1305, and atomically promote the account. Passwords—including legacy passwords shorter than eight characters—and plaintext notes never leave the browser. The administrator never needs to know those credentials, but each user must enter the original name and password because the archive contains only hashed names and encrypted notes.

The staged encrypted copy is retained for recovery and safe retries. Keep `LEGACY_MIGRATION_ENABLED=true` during the upgrade window, then set it to `false` once users no longer need first-login migration. Legacy public URLs continue to use sanitized staged snapshots.

If credentials for one account are available and an immediate server-side conversion is specifically needed, the credentialed `migrate-legacy --source data.db --username NAME [--dry-run]` command remains available.

Back up `data.db` and PostgreSQL before production migration. Neither migration path overwrites subsequently edited modern notes, and credentials, plaintext, keys, ciphertext, and note contents are never logged.

## Routes

- `/`, `/app`, `/app/notes/{id}` — landing page and React application shell
- `/ws` — authenticated encrypted synchronization
- `GET /api/v1/workspaces/{id}` and `POST /api/v1/workspaces` — public KDF/authentication metadata and registration
- `POST /api/v1/analytics` — optional, bounded first-party relay for allowlisted Umami pageviews and product events
- `/p/{id}` and `/p/{id}/raw` — current public snapshots
- `/{8-hex-id}` and `/{8-hex-id}/raw` — migrated public links
- `/healthz`, `/robots.txt`, `/manifest.webmanifest`, `/sw.js` — operations and PWA resources

The generated service worker caches only the app shell and build assets. API, WebSocket, health, and public snapshot routes are never runtime-cached.

## Disco deployment

`disco.json` declares one stateless `web` service on port 8251 and checks `http://127.0.0.1:8251/healthz`. Configure `DATABASE_URL` and, ideally, the public `SITE_URL` in Disco. Set `UMAMI_URL` to the Umami HTTP(S) origin and `UMAMI_WEBSITE_ID` to its UUID to enable the optional relay. No volume is declared because production data lives in external PostgreSQL.

Deploy the repository with Disco after its database is created, then run migrations through the release environment if the service has not started them already. Startup also safely applies pending migrations.

## Backups and interoperability

The recommended export is the portable encrypted archive. Plaintext JSON export is available behind a warning. Import accepts encrypted v2 archives, v2 plaintext exports, and legacy plaintext arrays or objects. Because IndexedDB is device-local, keep an encrypted archive outside the browser even when server synchronization is enabled.

## License

MIT
