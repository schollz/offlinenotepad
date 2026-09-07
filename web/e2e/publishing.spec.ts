import { expect, test, type Page } from '@playwright/test'

async function notebook(page: Page) {
  await page.goto('/')
  await page.getByLabel('Notebook name').fill(`html-${crypto.randomUUID()}`)
  await page.getByLabel('Password', { exact: true }).fill('synthetic publishing password')
  await page.getByRole('button', { name: 'Sign in or create notebook' }).click()
  await page.getByRole('button', { name: 'Create your first note' }).click()
  await page.getByLabel('Note title').fill('Interactive tool')
  await page.getByRole('button', { name: 'Source', exact: true }).click()
}

async function publish(page: Page, mode: string, updating = false) {
  await page.getByRole('button', { name: updating ? 'Update snapshot' : 'Publish', exact: true }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByLabel('Published format').selectOption(mode)
  await dialog.getByRole('button', { name: updating ? 'Update snapshot' : 'Publish snapshot', exact: true }).click()
  await expect(page.getByText('Public snapshot updated.', { exact: true })).toBeVisible()
  return (await page.getByRole('link', { name: /Public snapshot/ }).getAttribute('href'))!
}

const html = `<!doctype html><html><head><meta charset="utf-8"><style>button { color: rgb(12, 34, 56) }</style></head><body>
<button onclick="this.textContent='Working'">Run</button><output id="isolation"></output><output id="remote"></output>
<script>
const checks = [];
for (const attempt of [() => parent.document.body, () => localStorage.getItem('secret'), () => indexedDB.open('offlinenotepad-v2'), () => document.cookie]) {
  try { attempt(); checks.push('accessible') } catch { checks.push('blocked') }
}
document.querySelector('#isolation').textContent = checks.join(',');
try { eval('1') } catch { document.body.dataset.eval = 'blocked' }
</script><script src="https://fixture.example/library.js"></script>
</body></html>`

test('executes HTML while isolating the notebook and preserving explicit snapshots', async ({ page, context }) => {
  await context.route('https://fixture.example/library.js', (route) => route.fulfill({ contentType: 'text/javascript', body: "fetch('https://fixture.example/api').then(r => r.text()).then(text => document.querySelector('#remote').textContent = text)" }))
  await context.route('https://fixture.example/api', (route) => route.fulfill({ contentType: 'text/plain', headers: { 'Access-Control-Allow-Origin': '*' }, body: 'External dependency works' }))
  await notebook(page)
  await page.getByLabel('Note content').fill(html)
  const url = await publish(page, 'html')
  const viewer = await context.newPage()
  await viewer.goto(url)
  const frame = viewer.frameLocator('iframe')
  await frame.getByRole('button', { name: 'Run', exact: true }).click()
  await expect(frame.getByRole('button', { name: 'Working', exact: true })).toHaveCSS('color', 'rgb(12, 34, 56)')
  await expect(frame.locator('#isolation')).toHaveText('blocked,blocked,blocked,blocked')
  await expect(frame.locator('#remote')).toHaveText('External dependency works')
  await expect(frame.locator('body')).toHaveAttribute('data-eval', 'blocked')
  await expect(viewer.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts allow-forms')
  const endpoint = (await viewer.locator('iframe').getAttribute('src'))!
  const raw = await context.request.get(`${url}/raw`)
  expect(raw.headers()['content-type']).toContain('text/plain')
  expect(await raw.text()).toBe(html)
  const standalone = await context.newPage()
  const response = await standalone.goto(endpoint)
  expect(response?.headers()['content-security-policy']).toContain('sandbox allow-scripts allow-forms;')
  await expect(standalone.locator('#isolation')).toHaveText('accessible,blocked,blocked,blocked')
  await standalone.close()

  await page.getByLabel('Note content').fill('<button>Private edit</button>')
  await viewer.reload()
  await expect(frame.getByRole('button', { name: 'Run', exact: true })).toBeVisible()
  await expect(frame.getByRole('button', { name: 'Private edit' })).toHaveCount(0)
  const sameURL = await publish(page, 'html', true)
  expect(sameURL).toBe(url)
  await viewer.reload()
  await expect(frame.getByRole('button', { name: 'Private edit' })).toBeVisible()

  await page.getByRole('button', { name: 'More options' }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: /Remove public snapshot/ }).click()
  await expect.poll(async () => (await context.request.get(endpoint)).status()).toBe(404)
})

test('supports Markdown with HTML while keeping fenced code inert', async ({ page, context }) => {
  await notebook(page)
  await page.getByLabel('Note content').fill('# Mixed page\n\n<button onclick="this.textContent=\'Works\'">Run</button>\n\n```html\n<script>document.body.textContent="wrong"</script>\n```')
  const url = await publish(page, 'markdown-html')
  const viewer = await context.newPage()
  await viewer.goto(url)
  const frame = viewer.frameLocator('iframe')
  await expect(frame.getByRole('heading', { name: 'Mixed page' })).toBeVisible()
  await frame.getByRole('button', { name: 'Run' }).click()
  await expect(frame.getByRole('button', { name: 'Works' })).toBeVisible()
  await expect(frame.locator('pre')).toContainText('<script>document.body.textContent="wrong"</script>')
})

test('ordinary publishing keeps scripts inert and does not grant an executable endpoint', async ({ page, context }) => {
  await notebook(page)
  await page.getByLabel('Note content').fill('# Ordinary\n\n<script>document.body.textContent="wrong"</script>')
  const url = await publish(page, 'document')
  const viewer = await context.newPage()
  await viewer.goto(url)
  await expect(viewer.getByRole('heading', { name: 'Ordinary' })).toBeVisible()
  await expect(viewer.locator('iframe')).toHaveCount(0)
  expect((await context.request.get(`${url}/render`)).status()).toBe(404)
})
