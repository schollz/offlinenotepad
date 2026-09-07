// Run against a disposable production server. Uses synthetic notes only.
// ONP_BENCH_URL=http://127.0.0.1:18251 node web/scripts/benchmark.mjs
import { writeFileSync } from 'node:fs'
import { chromium } from '@playwright/test'

const browser = await chromium.launch({ headless: true })
process.on('SIGTERM', () => { void browser.close().finally(() => process.exit(1)) })
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
page.setDefaultTimeout(120_000)
const url = process.env.ONP_BENCH_URL ?? 'http://127.0.0.1:18251'
const count = Number(process.env.ONP_BENCH_NOTES ?? 500)
const sizes = (process.env.ONP_BENCH_SIZES ?? '10240,256000,1048576').split(',').map(Number)
const results = []
page.on('pageerror', (error) => console.error('Browser error:', error.message.slice(0, 160)))
try {
  await page.goto(url)
  await page.getByLabel('Notebook name').fill(`benchmark-${crypto.randomUUID()}`)
  await page.getByLabel('Password', { exact: true }).fill('synthetic benchmark password')
  await page.getByRole('button', { name: 'Sign in or create notebook' }).click()
  await page.waitForURL('**/app')
  const sourceFor = (size) => ('Paragraph with **bold**, a [link](https://example.com), and `code`.\n\n```js\nconst answer = 42;\n```\n\n').repeat(Math.ceil(size / 90)).slice(0, size)
  const notes = [
    ...Array.from({ length: Math.max(0, count - sizes.length) }, (_, i) => ({ title: `Corpus ${i}`, content: 'Synthetic searchable note. '.repeat(40), mode: 'markdown' })),
    ...sizes.map((size) => ({ title: `Benchmark ${size}`, content: sourceFor(size), mode: 'plaintext' })),
  ]
  await page.locator('input[type=file]').setInputFiles({ name: 'synthetic.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ format: 'offlinenotepad-plaintext', notes })) })
  await page.getByText(`Imported ${notes.length} note${notes.length === 1 ? '' : 's'}.`, { exact: true }).waitFor()
  // Measure offline so results isolate editing and durable local saving from network timing.
  await page.context().setOffline(true)
  const cdp = await page.context().newCDPSession(page)
  await page.evaluate(() => {
    window.benchmarkFrames = []
    document.addEventListener('keydown', (event) => {
      if (event.key.length !== 1 || event.metaKey || event.ctrlKey) return
      const start = performance.now()
      requestAnimationFrame(() => setTimeout(() => window.benchmarkFrames.push(performance.now() - start), 0))
    }, true)
  })
  for (const size of sizes) {
    console.error(`Preparing ${size} bytes`)
    if (process.env.ONP_BENCH_PROFILE) {
      await cdp.send('Profiler.enable')
      await cdp.send('Profiler.start')
      setTimeout(() => { void cdp.send('Profiler.stop').then(({ profile }) => writeFileSync(process.env.ONP_BENCH_PROFILE, JSON.stringify(profile))) }, 5000)
    }
    await page.getByRole('button', { name: `Benchmark ${size}`, exact: true }).click()
    await page.waitForTimeout(1000)
    for (const mode of ['live', 'source', 'plaintext']) {
      console.error(`Measuring ${mode}`)
      if (mode === 'plaintext') {
        await page.getByRole('button', { name: 'More options' }).click()
        await page.getByRole('button', { name: /Format: Markdown/ }).click()
        await page.keyboard.press('Escape')
      } else {
        if (!(await page.getByRole('button', { name: 'Live', exact: true }).count())) {
          await page.getByRole('button', { name: 'More options' }).click()
          await page.getByRole('button', { name: /Format: Plain text/ }).click()
          await page.keyboard.press('Escape')
        }
        await page.getByRole('button', { name: mode === 'live' ? 'Live' : 'Source', exact: true }).click()
      }
      const editor = page.getByLabel('Note content')
      await page.waitForTimeout(1000)
      for (const rate of [1, 4]) {
        await cdp.send('Emulation.setCPUThrottlingRate', { rate })
        await editor.focus()
        await page.keyboard.press('ControlOrMeta+Home')
        await page.evaluate(() => { window.benchmarkFrames = [] })
        await page.keyboard.type('abcdefghijklmnopqrstuvwxyz'.repeat(2), { delay: 35 })
        await page.waitForTimeout(500)
        const samples = await page.evaluate(() => window.benchmarkFrames)
        samples.sort((a, b) => a - b)
        const result = { notes: count, bytes: size, mode, cpu: rate, samples: samples.length, p95ms: Math.round(samples[Math.floor(samples.length * .95)] ?? 0), maxMs: Math.round(samples.at(-1) ?? 0) }
        results.push(result)
        console.log(JSON.stringify(result))
      }
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 })
    }
  }
} catch (error) {
  console.error(String(error.message).split('Call log:')[0].slice(0, 240))
  process.exitCode = 1
} finally {
  await browser.close()
}
