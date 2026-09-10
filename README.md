
<p align="center">
<img
    src="https://user-images.githubusercontent.com/6550035/58387410-d2e33780-7fc2-11e9-8823-ce290b1cce7a.png"
    width="408px" border="0" alt="offlinenotepad">
</p>

<p align="center"><code><a href="https://offlinenotepad.com">https://offlinenotepad.com</a></code></p>

*offlinenotepad* is an [open-source](https://github.com/schollz/offlinenotepad) offline note taking app. It is a browser-based offline-first notepad that securely syncs across your devices - including smartphones, laptops, and chromebooks. Ideally, its a minimalist note-writing experience that can be accessed anywhere, anytime. 

**Offline-first.** All information is stored as encrypted data in the browser. Saving, editing, viewing, and searching are all done on the client.

**Secure.** offlinenotepad uses AES with the PBE algorithm (PBKDF2) with the [crypto-js library](https://github.com/brix/crypto-js) to encrypt data on the client and the server.

**Minimal.** This offline notepad aims to do as much as possible with as little as possible.

**Publish.** Any page can be "published" so that is accessible by anyone with a simple random link, like [`offlinenotepad.com/50e5791a`](https://offlinenotepad.com/50e5791a). The raw data can easily be easily cURLed by adding `/raw` to the end, e.g. [`offlinenotepad.com/50e5791a/raw`](https://offlinenotepad.com/50e5791a/raw).

**Code.** If the title of any document contains a period (".") then it will force the editor to be monospace and it will show the plain text in the viewer instead of transformed Markdown to HTML.

This writing tool is largely based of its predecessors: [cowyo](https://cowyo.com) and [rwtxt.com](https://rwtxt.com) (both also available on Github).

## Install

The frontend is built with Vite and React, then bundled into the Go executable using
`go:embed`. Building requires Go 1.16+ and Node.js 20.19+ or 22.12+ (Node.js 24 LTS
is recommended). Running the compiled server needs neither Node.js nor frontend files.

```
$ git clone https://github.com/schollz/offlinenotepad
$ cd offlinenotepad
$ make build
```

And then you can run

```

$ ./offlinenotepad
```

Log into `localhost:8251` to see the site.

`make build` runs `go generate` (which runs `npm ci` and `npm run build`), then
builds the Go executable with the updated `frontend/dist` output embedded. Re-run
`make build` after changing the frontend or Go code. Generated
assets are intentionally ignored by Git; a fresh checkout must build them first.

### Development

The React components, note storage/sync code, and existing stylesheet live in
`frontend/src`. Dependencies are managed through the root `package.json`.

```sh
npm ci
npm run build
go run .
```

In another terminal, run `npm run dev` and open the URL Vite prints. Vite proxies
WebSockets and the published-document API to Go on port 8251. Hot reload is available
in development; the offline service worker runs only in production builds.
For a different Go address, set `NOTEPAD_BACKEND`, for example
`NOTEPAD_BACKEND=http://localhost:8254 npm run dev`.

The existing Markdown renderer and dialog version are retained to preserve note
rendering and appearance. The Showdown CLI's unused `yargs` dependency is overridden
to remove its obsolete dependency tree; the browser renderer is unchanged.
`npm audit` still reports one moderate issue for the retained Showdown dependency,
which has no patched release available.

The production worker precaches the built assets, supports offline note URLs, and
replaces old app caches on activation. After an update, close all app tabs and reopen
to activate the new worker. Encrypted local notes are stored separately and retained.

```sh
npm test
go test ./...
npx playwright install chromium
npm run test:e2e
```

Browser tests build an isolated server using a temporary database and fresh browser
storage. They do not access your notes.

### Docker

Alternatively you can run with docker:

```
$ docker run -v /location/to/save/data:/data -p 8251:8251 schollz/offlinenotepad
```

To build this version locally, run `docker build -t offlinenotepad .`. The multistage
build installs frontend dependencies, builds Vite, and embeds its output into Go.

## Acknowledgements

I took a lot of help from @GoogleChromeLabs with their [airhorn](https://github.com/GoogleChromeLabs/airhorn).

## License

MIT
