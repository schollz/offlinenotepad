import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

// Generate the precache from the actual Vite output, including hashed chunks.
export function offlineCache() {
  let outDir;
  return {
    name: 'offline-notepad-cache',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    async closeBundle() {
      async function filesIn(directory) {
        const entries = await readdir(directory, { withFileTypes: true });
        return (await Promise.all(entries.map(entry => {
          const path = join(directory, entry.name);
          return entry.isDirectory() ? filesIn(path) : path;
        }))).flat();
      }
      const files = (await filesIn(outDir)).filter(file => !file.endsWith('/sw.js')).sort();
      const template = await readFile(new URL('../src/sw.js', import.meta.url), 'utf8');
      const hash = createHash('sha256').update(template);
      for (const file of files) hash.update(relative(outDir, file)).update(await readFile(file));
      const urls = ['/', ...files.map(file => '/' + relative(outDir, file).split('\\').join('/'))];
      await writeFile(join(outDir, 'sw.js'), template
        .replace('__CACHE_VERSION__', hash.digest('hex').slice(0, 16))
        .replace('__PRECACHE_URLS__', JSON.stringify(urls)));
    },
  };
}
