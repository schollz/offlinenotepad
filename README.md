# Offline Notepad

Offline Notepad is a minimal, offline-first notebook that securely syncs across browsers and devices.

**Offline-first.** Notes are saved to IndexedDB before network synchronization, so editing and searching work without a connection.

**Private.** Notes are encrypted in the browser with XChaCha20-Poly1305. Passwords, private keys, and plaintext notes never reach the server. There is no password recovery.

**Simple.** Any notebook name and non-empty password opens an existing notebook or creates a new one. A saved browser login reopens automatically until you log out.

**Publish.** A note can be shared as an explicit read-only snapshot. Later private edits are not published automatically.

The app ships as one CGO-free Go binary with an embedded React frontend. It uses PostgreSQL when `DATABASE_URL` is set and SQLite otherwise.

## Install

Requires Go 1.26.8 and Node.js 24.

```sh
git clone https://github.com/schollz/offlinenotepad
cd offlinenotepad
make frontend-install
make build
./offlinenotepad
```

Open `http://localhost:8251`. Without `DATABASE_URL`, data is stored in `offlinenotepad.sqlite3` by default. See `.env.example` for configuration.

### Docker

```sh
docker build -t offlinenotepad .
docker run -p 8251:8251 -v offlinenotepad-data:/data offlinenotepad
```

## Legacy migration

To stage every account from an old bbolt `data.db` into PostgreSQL:

```sh
./offlinenotepad -migrate /path/to/data.db --dry-run
./offlinenotepad -migrate /path/to/data.db
```

The archive-wide migration does not require usernames or passwords. Users complete migration by opening their notebook with its original credentials. Back up both databases first.

## Development

```sh
make dev
make test
make lint
make test-race
```

## License

MIT
