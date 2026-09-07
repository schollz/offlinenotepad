# Publishing HTML and interactive notes

Choose **Publish** (or **Update snapshot**) and select a published format:

- **Current note format** publishes the existing sanitized Markdown or plain-text snapshot.
- **HTML page** uses the note body as HTML, including complete documents, CSS, and JavaScript.
- **Markdown with HTML** renders Markdown and preserves embedded HTML, styles, and scripts. Fenced code blocks remain displayed source code.

For example, publish this using **HTML page**:

```html
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Counter</title>
<style>button { padding: 1rem; font: inherit; }</style>
<button onclick="this.textContent = Number(this.textContent) + 1">0</button>
</html>
```

Existing snapshots keep their current behavior until their owner explicitly selects an executable format and republishes. Updating a snapshot preserves its public URL, including legacy eight-character URLs. Private edits never update a public snapshot automatically. **View raw** continues to return the original source as plain text.

Interactive content runs in a sandboxed frame and has its own response-level sandbox when opened directly. It cannot access the private notebook's DOM, cookies, localStorage, IndexedDB, or keys. The application does not execute scripts in the private editor.

Inline scripts and styles, HTTPS libraries/styles/images/fonts/media, and HTTPS API calls are supported. External APIs must permit requests from the sandbox's opaque origin (`Origin: null`), such as public APIs using `Access-Control-Allow-Origin: *`. Use absolute HTTPS dependency URLs. This is browser execution; PHP, Python, and other server-side runtimes are not provided.

Persistent browser storage, popups, nested iframes, plugins, dynamic evaluation (`eval`/`new Function`), and navigation of the outer page from the frame are unavailable. There is no server-side proxy for external services. Libraries depending on those capabilities may need changes. Executable responses are not cached by the service worker and use `Cache-Control: no-store`.

# Editing and saving

Markdown Live, Source, and plain text use the same virtualized editor. Switching formats preserves the source and undo history. Native spellcheck is disabled above 100,000 characters to bound browser spellchecking work; source text and highlighting are unaffected.

**Saving…** means the newest edit is still being encrypted or written locally. **Saved offline** means encrypted data is durable in IndexedDB and synchronization is pending. **Synced** means the server acknowledged it. A failed edit save retains the draft and offers **Retry**. Publishing, exports, logout, and password rotation wait for pending local saves. Abrupt browser/process termination before local saving completes cannot guarantee recovery of those unfinished edits.

# Performance checks

Build the production frontend, start a disposable server, then run the synthetic benchmark:

```sh
make frontend
node web/scripts/test-server.mjs
# In another terminal:
ONP_BENCH_URL=http://127.0.0.1:18252 node web/scripts/benchmark.mjs
```

The server uses a fresh temporary directory and SQLite database and does not load project environment files. The benchmark imports synthetic notes through the UI, measures offline editing with 500 notes, and reports p95 keydown-to-next-paint approximation at normal and 4× CPU slowdown. Import initializes large fixtures without including browser automation's bulk-input overhead in the typing measurement. Run it without concurrent browser tests or builds. `ONP_BENCH_NOTES` and `ONP_BENCH_SIZES` override the corpus size and comma-separated active-note byte sizes.

Timing thresholds are review targets on a consistent machine, not flaky shared-runner assertions: 50 ms normally and 100 ms at 4× slowdown for 10 KB and 250 KB notes. A 1 MB case exercises sustained editing and bounded queues. Unit tests separately verify save coalescing and incremental rendering correctness.

## Measurements from 2026-09-07

Production builds on the same macOS machine, headless Chromium, 500 synthetic notes, 52 keystrokes per case, 4× CPU slowdown. Values are p95 milliseconds using the approximation described above.

| Active note | Editor | Before | After |
|---|---|---:|---:|
| 10 KB | Markdown Live | 443 | 23 |
| 10 KB | Markdown Source | 656 | 22 |
| 10 KB | Plain text | 436 | 22 |
| 250 KB | Markdown Live | 773 | 28 |
| 250 KB | Markdown Source | 757 | 23 |
| 250 KB | Plain text | 668 | 24 |

The separate 1 MiB stress run with 500 notes measured 25–32 ms p95 at 4× slowdown across all three editor modes. Timing varies by device and browser; these measurements are not production telemetry.
