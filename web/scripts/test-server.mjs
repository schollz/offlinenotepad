import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const directory = mkdtempSync(join(tmpdir(), 'offlinenotepad-e2e-'))
const binary = join(directory, 'offlinenotepad')
const build = spawnSync('go', ['build', '-o', binary, './cmd/offlinenotepad'], { cwd: root, env: { ...process.env, CGO_ENABLED: '0' }, stdio: 'inherit' })
if (build.status !== 0) process.exit(build.status ?? 1)
// A fresh working directory prevents loading project .env or real databases.
const server = spawn(binary, ['serve', '-port', process.env.ONP_TEST_PORT ?? '18252', '-log', 'error'], {
  cwd: directory,
  env: { ...process.env, DATABASE_URL: '', SQLITE_PATH: resolve(directory, 'test.sqlite3'), SITE_URL: '', UMAMI_URL: '', UMAMI_WEBSITE_ID: '', ALLOWED_ORIGINS: '', LEGACY_MIGRATION_ENABLED: 'true' },
  stdio: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.kill(signal))
server.on('exit', (code) => process.exit(code ?? 0))
