import { expect, test, type Page } from '@playwright/test'

const password = 'correct horse battery staple'

function notebookName(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`
}

async function createNotebook(page: Page, name: string) {
  await page.goto('/')
  await page.getByLabel('Notebook name').fill(name)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Open notebook' }).click()
  await expect(page).toHaveURL(/\/app/u)
}

async function createNote(page: Page, title = 'A field note') {
  const first = page.getByRole('button', { name: 'Create your first note' })
  if (await first.isVisible()) await first.click()
  else await page.getByRole('button', { name: /New note/ }).click()
  await page.getByLabel('Note title').fill(title)
  await expect(page.getByLabel('Note title')).toHaveValue(title)
  await page.getByLabel('Note content').fill('# Hello\n\nAn encrypted note.')
  await expect(page.getByLabel('Note title')).toHaveValue(title)
  await page.waitForTimeout(75)
  await expect(page.getByText('Synced', { exact: true })).toBeVisible()
}

test('creates, edits in live preview, and publishes an explicit snapshot', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'covered in the mobile scenario')
  await createNotebook(page, notebookName('e2e'))
  await createNote(page)
  await expect(page.getByRole('button', { name: 'Live' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('heading', { name: 'Hello' })).toBeVisible()
  await page.getByRole('button', { name: 'Source' }).click()
  await expect(page.getByLabel('Note content')).toContainText('# Hello')
  await page.getByRole('button', { name: 'Live' }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Publish' }).click()
  const snapshot = page.getByRole('link', { name: /Public snapshot/ })
  await expect(snapshot).toBeVisible()
  const publicPage = await page.context().newPage()
  await publicPage.goto(await snapshot.getAttribute('href') ?? '')
  await expect(publicPage.getByText('Shared snapshot')).toBeVisible()
  await expect(publicPage.getByRole('heading', { name: 'A field note' })).toBeVisible()
  await publicPage.getByRole('link', { name: 'View raw' }).click()
  await expect(publicPage.locator('body')).toContainText('# Hello')
})

test('creates an unknown notebook with a short password from the unified form', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'covered by the desktop credential flow')
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Create' })).toHaveCount(0)
  await page.getByLabel('Notebook name').fill(notebookName('short-password'))
  await page.getByLabel('Password').fill('tiny')
  await page.getByRole('button', { name: 'Open notebook' }).click()
  await expect(page).toHaveURL(/\/app/u)
  await expect(page.getByRole('button', { name: 'Create your first note' })).toBeVisible()
})

test('renders GFM and highlighted code without executing note content or fetching remote images', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'covered in the mobile scenario')
  await createNotebook(page, notebookName('live-preview'))
  await createNote(page, 'Live preview')
  let remoteImageRequested = false
  page.on('request', (request) => {
    if (request.url() === 'https://example.com/private.png') remoteImageRequested = true
  })
  await page.getByLabel('Note content').fill([
    '# Formatted',
    '',
    '**Bold** and `inline code`',
    '',
    '- [ ] A task',
    '',
    '| Name | Value |',
    '|:---|---:|',
    '| Answer | 42 |',
    '',
    '![Private](https://example.com/private.png)',
    '',
    '```ts',
    'const answer: number = 42',
    '```',
    '',
    '<script>window.__noteScriptExecuted = true</script>',
  ].join('\n'))

  await expect(page.getByRole('heading', { name: 'Formatted' })).toBeVisible()
  await expect(page.getByRole('table')).toBeVisible()
  await expect(page.getByRole('checkbox', { name: 'Mark task complete' })).toBeVisible()
  await expect(page.getByRole('button', { name: /Private.*edit Markdown source/ })).toContainText('https://example.com/private.png')
  const highlightedCode = page.locator('.cm-live-code-line').filter({ hasText: 'const answer' })
  await expect(highlightedCode).toBeVisible()
  await expect.poll(() => highlightedCode.locator('span[class]').count()).toBeGreaterThan(0)
  await page.waitForTimeout(200)
  expect(remoteImageRequested).toBe(false)
  expect(await page.evaluate(() => (window as typeof window & { __noteScriptExecuted?: boolean }).__noteScriptExecuted)).not.toBe(true)

  await page.getByRole('checkbox', { name: 'Mark task complete' }).click()
  await expect(page.getByRole('checkbox', { name: 'Mark task incomplete' })).toBeChecked()
  await page.getByRole('button', { name: 'Source', exact: true }).click()
  await expect(page.getByLabel('Note content')).toContainText('- [x] A task')
  await expect(page.getByLabel('Note content')).toContainText('<script>window.__noteScriptExecuted = true</script>')
})

test('starts offline from the cached shell and saves locally before reconnecting', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'covered in the mobile scenario')
  const name = notebookName('offline')
  await createNotebook(page, name)
  await createNote(page, 'Offline work')
  await page.evaluate(() => navigator.serviceWorker.ready)
  await page.context().setOffline(true)
  await page.reload()
  await expect(page.getByLabel('Notebook name')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /Offline work/ })).toBeVisible()
  await page.getByRole('button', { name: /Offline work/ }).click()
  await page.getByLabel('Note content').fill('Written while fully offline.')
  await expect(page.getByText('Saved offline', { exact: true })).toBeVisible()
  await page.context().setOffline(false)
  await expect(page.getByText('Synced', { exact: true })).toBeVisible()
})

test('restores the saved browser login and removes it on logout', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'covered by the desktop credential flow')
  await createNotebook(page, notebookName('saved-login'))
  await page.reload()
  await expect(page.getByRole('button', { name: 'Create your first note' })).toBeVisible()
  await expect(page.getByLabel('Notebook name')).toHaveCount(0)

  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByRole('button', { name: /Log out/ }).click()
  await expect(page.getByLabel('Notebook name')).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Notebook name')).toBeVisible()
})

test('mobile layout uses a drawer and preserves editor access', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile-only layout assertion')
  await createNotebook(page, notebookName('mobile'))
  await createNote(page, 'Pocket note')
  await page.getByRole('button', { name: 'Open notes' }).click()
  await expect(page.getByRole('complementary', { name: 'Notes' })).toBeVisible()
  await page.getByRole('button', { name: /Pocket note/ }).click()
  await expect(page.getByLabel('Note content')).toBeVisible()
})

test('preserves simultaneous offline edits as a conflict copy', async ({ page, browser }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop multi-device scenario')
  const name = notebookName('conflict')
  await createNotebook(page, name)
  await createNote(page, 'Shared note')

  const secondContext = await browser.newContext()
  const second = await secondContext.newPage()
  await second.goto('/')
  await second.getByLabel('Notebook name').fill(name)
  await second.getByLabel('Password').fill(password)
  await second.getByRole('button', { name: 'Open notebook' }).click()
  await second.getByRole('button', { name: /Shared note/ }).click()
  await secondContext.setOffline(true)
  await second.getByLabel('Note content').fill('Unsent edit from the second device.')
  await expect(second.getByText('Saved offline', { exact: true })).toBeVisible()

  await page.getByLabel('Note content').fill('Server edit from the first device.')
  await expect(page.getByText('Synced', { exact: true })).toBeVisible()
  await secondContext.setOffline(false)
  const conflict = second.getByRole('button', { name: /Shared note \(conflict/ })
  await expect(conflict).toHaveCount(1)
  await expect(conflict).toBeVisible()
  await conflict.click()
  await expect(second.getByLabel('Note content')).toContainText('Unsent edit from the second device.')
  await secondContext.close()
})

test('coordinates same-browser tabs without multiplying conflicts and transfers the sender lock', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop multi-tab scenario')
  await createNotebook(page, notebookName('same-browser-tabs'))
  await createNote(page, 'Shared tab note')

  const second = await page.context().newPage()
  await second.goto('/app')
  await expect(second.getByLabel('Notebook name')).toHaveCount(0)
  const mainNote = (target: Page) => target.locator('.note-row').filter({
    has: target.locator('.note-title', { hasText: /^Shared tab note$/u }),
  })
  const conflicts = (target: Page) => target.locator('.note-title').filter({ hasText: /\(conflict /u })
  await mainNote(second).click()
  await expect(second.getByLabel('Note content')).toContainText('An encrypted note.')

  await page.waitForTimeout(1_000)
  await expect(conflicts(page)).toHaveCount(0)
  await expect(conflicts(second)).toHaveCount(0)

  await page.getByLabel('Note content').fill('One ordinary edit from the first tab.')
  await expect(page.getByText('Synced', { exact: true })).toBeVisible()
  await expect(second.getByLabel('Note content')).toContainText('One ordinary edit from the first tab.')
  await expect(conflicts(page)).toHaveCount(0)
  await expect(conflicts(second)).toHaveCount(0)

  await Promise.all([
    page.getByLabel('Note content').fill('Concurrent edit from the first tab.'),
    second.getByLabel('Note content').fill('Concurrent edit from the second tab.'),
  ])
  await expect(conflicts(page)).toHaveCount(1)
  await expect(conflicts(second)).toHaveCount(1)
  await page.waitForTimeout(2_000)
  await expect(conflicts(page)).toHaveCount(1)
  await expect(conflicts(second)).toHaveCount(1)

  await page.close()
  await mainNote(second).click()
  await second.getByLabel('Note content').fill('Saved after the original sender tab closed.')
  await expect(second.getByText('Synced', { exact: true })).toBeVisible()
  await second.reload()
  await mainNote(second).click()
  await expect(second.getByLabel('Note content')).toContainText('Saved after the original sender tab closed.')
  await expect(conflicts(second)).toHaveCount(1)
})

test('rotates credentials and requires the new password', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop credential scenario')
  const name = notebookName('rotation')
  const nextPassword = 'a new correct horse battery staple'
  await createNotebook(page, name)
  await createNote(page, 'Rotated note')
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByRole('button', { name: /Change password/ }).click()
  await page.getByLabel('New password').fill(nextPassword)
  await page.getByRole('button', { name: 'Change password', exact: true }).last().click()
  await expect(page.getByText('Password changed. Other devices must open the notebook again.')).toBeVisible()
  await page.getByRole('button', { name: /Log out/ }).click()

  await page.getByLabel('Notebook name').fill(name)
  await page.getByLabel('Password').fill(password)
  await page.getByRole('button', { name: 'Open notebook' }).click()
  await expect(page.getByText('The password is incorrect.')).toBeVisible()
  await page.getByLabel('Password').fill(nextPassword)
  await page.getByRole('button', { name: 'Open notebook' }).click()
  await expect(page.getByRole('button', { name: /Rotated note/ })).toBeVisible()
})

test('analytics stays normalized and outside the service worker cache', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'desktop privacy scenario')
  const submissions: Record<string, unknown>[] = []
  const servedByServiceWorker: boolean[] = []
  await page.context().route('**/api/v1/analytics', async (route) => {
    submissions.push(route.request().postDataJSON() as Record<string, unknown>)
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      headers: { 'Cache-Control': 'no-store' },
      body: JSON.stringify({ cache: 'opaque.browser-session' }),
    })
  })
  page.context().on('response', (response) => {
    if (response.url().endsWith('/api/v1/analytics')) servedByServiceWorker.push(response.fromServiceWorker())
  })

  const name = notebookName('private-notebook-name')
  const originalPassword = 'private-original-password'
  const nextPassword = 'private-rotated-password'
  const title = 'Private telemetry title'
  const content = 'Private telemetry content and ciphertext-like AABBCC112233'
  const search = 'private telemetry search'

  await page.goto('/')
  await page.getByLabel('Notebook name').fill(name)
  await page.getByLabel('Password').fill(originalPassword)
  await page.getByRole('button', { name: 'Open notebook' }).click()
  await expect(page).toHaveURL(/\/app/u)
  await createNote(page, title)
  await page.getByLabel('Note content').fill(content)
  await expect(page.getByText('Synced', { exact: true })).toBeVisible()
  const noteID = new URL(page.url()).pathname.split('/').at(-1) ?? ''

  await expect.poll(() => submissions.filter((entry) => entry.kind === 'pageview' && entry.page === 'note').length).toBe(1)

  await page.getByLabel('Search notes').fill(search)
  await page.getByLabel('Search notes').clear()

  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Publish' }).click()
  const snapshot = page.getByRole('link', { name: /Public snapshot/ })
  await expect(snapshot).toBeVisible()
  const snapshotHref = await snapshot.getAttribute('href') ?? ''
  const publicID = snapshotHref.split('/').at(-1) ?? ''
  const publicPage = await page.context().newPage()
  await publicPage.goto(snapshotHref)
  await expect(publicPage.getByText('Shared snapshot')).toBeVisible()
  await publicPage.close()

  await page.getByRole('button', { name: 'More options' }).click()
  const encryptedDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: /Encrypted archive/ }).click()
  await encryptedDownload
  page.once('dialog', (dialog) => dialog.accept())
  const plaintextDownload = page.waitForEvent('download')
  await page.getByRole('button', { name: /Plaintext JSON/ }).click()
  await plaintextDownload

  await page.locator('input[type="file"]').setInputFiles({
    name: 'private-import.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({
      format: 'offlinenotepad-plaintext',
      version: 2,
      notes: [{ title: 'Private imported title', content: 'Private imported content' }],
    })),
  })
  await expect(page.getByText('Imported 1 note.')).toBeVisible()
  await page.locator('aside[aria-label="Notebook settings"]').getByRole('button', { name: 'Close settings' }).click()
  await page.getByRole('button', { name: /Private imported title/ }).click()
  await expect.poll(() => submissions.filter((entry) => entry.kind === 'pageview' && entry.page === 'note').length).toBe(2)
  await page.getByRole('button', { name: new RegExp(title) }).click()
  await expect.poll(() => submissions.filter((entry) => entry.kind === 'pageview' && entry.page === 'note').length).toBe(3)

  await page.getByRole('button', { name: 'More options' }).click()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: /Remove public snapshot/ }).click()
  await expect(page.getByRole('link', { name: /Public snapshot/ })).toHaveCount(0)

  await page.getByRole('button', { name: /Change password/ }).click()
  await page.getByLabel('New password').fill(nextPassword)
  await page.getByRole('button', { name: 'Change password', exact: true }).last().click()
  await expect(page.getByText('Password changed. Other devices must open the notebook again.')).toBeVisible()
  await page.getByRole('button', { name: /Log out/ }).click()
  await page.getByLabel('Notebook name').fill(name)
  await page.getByLabel('Password').fill(nextPassword)
  await page.getByRole('button', { name: 'Open notebook' }).click()
  await expect(page.getByRole('button', { name: new RegExp(title) })).toBeVisible()

  const requiredEvents = [
    'notebook-create', 'notebook-unlock', 'note-create', 'snapshot-publish',
    'snapshot-unpublish', 'archive-export', 'archive-import', 'password-rotate',
  ]
  await expect.poll(() => new Set(submissions.map((entry) => entry.event).filter(Boolean))).toEqual(new Set(requiredEvents))
  expect(submissions.filter((entry) => entry.kind === 'pageview' && entry.page === 'landing')).toHaveLength(2)
  expect(submissions.some((entry) => entry.kind === 'pageview' && entry.page === 'public-snapshot')).toBe(true)
  expect(servedByServiceWorker.length).toBeGreaterThan(0)
  expect(servedByServiceWorker).not.toContain(true)

  const telemetry = JSON.stringify(submissions)
  for (const privateValue of [
    name, originalPassword, nextPassword, title, content, search, noteID, publicID,
    'Private imported title', 'Private imported content',
  ]) {
    expect(telemetry).not.toContain(privateValue)
  }
})
