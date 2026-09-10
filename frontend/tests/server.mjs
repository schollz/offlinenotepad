import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const directory = mkdtempSync(join(tmpdir(), 'offlinenotepad-test-'));
const binary = join(directory, 'server');
for (const [command, args] of [['npm', ['run', 'build']], ['go', ['build', '-o', binary, '.']]]) {
  const result = spawnSync(command, args, { stdio: 'inherit' });
  if (result.status !== 0) { rmSync(directory, { recursive: true, force: true }); process.exit(result.status || 1); }
}
// Run outside the repository: the executable must serve entirely from go:embed.
const server = spawn(binary, ['--port', '8253', '--db', join(directory, 'test.db')], { cwd: directory, stdio: 'inherit' });
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.kill(signal));
server.on('exit', code => { rmSync(directory, { recursive: true, force: true }); process.exit(code || 0); });
