# Offline Notepad

Offline Notepad is a minimal, offline-first notebook that securely syncs across browsers and devices.

**Offline-first.** Notes are saved to IndexedDB before network synchronization, so editing and searching work without a connection.

**Private.** Notes are encrypted in the browser with XChaCha20-Poly1305. Passwords, private keys, and plaintext notes never reach the server. There is no password recovery.

**Simple.** Any notebook name and non-empty password opens an existing notebook or creates a new one. A saved browser login reopens automatically until you log out.

**Publish.** A note can be shared as an explicit read-only snapshot. Later private edits are not published automatically.

The app ships as one CGO-free Go binary with an embedded React frontend. It uses PostgreSQL when `DATABASE_URL` is set and SQLite otherwise.

## Install

Requires Go 1.27.1, Node.js 24, and npm.

```sh
git clone https://github.com/schollz/offlinenotepad
cd offlinenotepad
make build
./offlinenotepad
```

`make build` installs the locked frontend dependencies when needed, generates the ignored frontend output in `internal/site/build`, and embeds it in the Go binary. Docker performs the same frontend build in its Node stage, so generated assets are not kept in Git or required in the Docker build context.

Open `http://localhost:8251`. Without `DATABASE_URL`, data is stored in `offlinenotepad.sqlite3` by default. See `.env.example` for configuration.

For a public deployment, set `SITE_URL` to the site's HTTPS origin (for example, `https://notes.example.com`). Canonical links, social previews, `robots.txt`, JSON-LD, and the sitemap use this value.

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
make serve
make test
make lint
make test-race
```

`make serve` uses Air to rebuild the embedded frontend and Go server, then reloads the browser at `http://localhost:8251` when their source files change. `make dev` is an alias for the same development server.
Set `AIR_PROXY_PORT` and `AIR_APP_PORT` to use another pair of ports when running more than one development server.

## License

MIT
