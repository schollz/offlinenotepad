import { expect, test, type Page } from '@playwright/test'

async function createNote(page: Page) {
  await page.goto('/')
  await page.getByLabel('Notebook name').fill(`saving-${crypto.randomUUID()}`)
  await page.getByLabel('Password', { exact: true }).fill('synthetic saving password')
  await page.getByRole('button', { name: 'Sign in or create notebook' }).click()
  await page.getByRole('button', { name: 'Create your first note' }).click()
  await page.getByLabel('Note title').fill('Durable note')
  await expect(page.getByText('Synced', { exact: true })).toBeVisible()
}

test('keeps saving status honest and drains the latest edit before publishing and logout', async ({ page, context }) => {
  test.skip(test.info().project.name === 'mobile', 'desktop queue lifecycle coverage')
  await page.addInitScript(() => {
    const NativeWorker = window.Worker
    window.Worker = class extends NativeWorker {
      postMessage(message: unknown, options?: Transferable[]) {
        if (message && typeof message === 'object' && 'record' in message) {
          setTimeout(() => super.postMessage(message, options ?? []), 250)
        } else super.postMessage(message, options ?? [])
      }
    }
  })
  await createNote(page)
  await page.getByLabel('Note content').fill('Newest snapshot content')
  await expect(page.getByText('Saving…', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Publish', exact: true }).click()
  await page.getByRole('button', { name: 'Publish snapshot', exact: true }).click()
  const link = page.getByRole('link', { name: /Public snapshot/ })
  await expect(link).toBeVisible()
  const raw = await context.request.get(`${await link.getAttribute('href')}/raw`)
  expect(await raw.text()).toBe('Newest snapshot content')
  await page.getByLabel('Note content').fill('Final edit before logout')
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByRole('button', { name: /Log out|Sign out|Forget this browser/i }).click()
  await expect(page.getByLabel('Notebook name')).toBeVisible()
  const pendingCount = await page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve) => { const request = indexedDB.open('offlinenotepad-v2'); request.onsuccess = () => resolve(request.result) })
    try {
      return await new Promise<number>((resolve) => { const request = db.transaction('documents').objectStore('documents').count(); request.onsuccess = () => resolve(request.result) })
    } finally { db.close() }
  })
  expect(pendingCount).toBeGreaterThan(0)
})

test('retains edits after storage failure and successfully retries', async ({ page, context }) => {
  test.skip(test.info().project.name === 'mobile', 'desktop failure recovery coverage')
  await createNote(page)
  await context.setOffline(true)
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'documents') {
        IDBObjectStore.prototype.put = original
        throw new DOMException('Synthetic storage failure', 'QuotaExceededError')
      }
      return original.apply(this, args)
    }
  })
  await page.getByLabel('Note content').fill('Preserve this offline edit')
  await page.getByRole('button', { name: 'Save failed · Retry' }).click()
  await expect(page.getByText('Saved offline', { exact: true })).toBeVisible()
  await page.reload()
  await expect(page.getByLabel('Note content')).toContainText('Preserve this offline edit')
})

test('preserves an unsent local edit as a conflict copy when another device deletes the note', async ({ page, context, browser }) => {
  test.skip(test.info().project.name === 'mobile', 'desktop two-device lifecycle coverage')
  const name = `delete-conflict-${crypto.randomUUID()}`
  const password = 'synthetic conflict password'
  const open = async (target: Page) => {
    await target.goto('/')
    await target.getByLabel('Notebook name').fill(name)
    await target.getByLabel('Password', { exact: true }).fill(password)
    await target.getByRole('button', { name: 'Sign in or create notebook' }).click()
  }
  await open(page)
  await page.getByRole('button', { name: 'Create your first note' }).click()
  await page.getByLabel('Note title').fill('Deleted elsewhere')
  await page.getByLabel('Note content').fill('Original shared content')
  await expect(page.getByText('Synced', { exact: true })).toBeVisible()
  const otherContext = await browser.newContext({ baseURL: test.info().project.use.baseURL })
  try {
    const other = await otherContext.newPage()
    await open(other)
    await expect(other.getByLabel('Note content')).toContainText('Original shared content')
    await context.setOffline(true)
    await page.getByLabel('Note content').fill('Unsent local content to preserve')
    await expect(page.getByText('Saved offline', { exact: true })).toBeVisible()
    await other.getByRole('button', { name: 'More options' }).click()
    other.once('dialog', (dialog) => dialog.accept())
    await other.getByRole('button', { name: /Delete note/ }).click()
    await expect(other.locator('.note-title')).toHaveCount(0)
    await context.setOffline(false)
    await expect(page.locator('.note-title').filter({ hasText: /\(conflict / })).toHaveCount(1)
    await expect(page.getByLabel('Note content')).toContainText('Unsent local content to preserve')
    await expect(page.getByText('Synced', { exact: true })).toBeVisible()
    await expect(other.locator('.note-title')).toHaveCount(1)
  } finally { await otherContext.close() }
})

test('pastes a large note and preserves source and undo across editor formats', async ({ page, context }) => {
  test.skip(test.info().project.name === 'mobile', 'desktop paste and undo coverage')
  await createNote(page)
  await context.setOffline(true)
  const text = '# Large note\n\n' + 'Plain text **markup** with Unicode: 日本語 café.\n\n'.repeat(5000) + 'Last line.'
  const editor = page.getByLabel('Note content')
  await editor.focus()
  await editor.evaluate((element, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  }, text)
  await expect(page.getByText('Saved offline', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'More options' }).click()
  await page.getByRole('button', { name: /Format: Markdown/ }).click()
  await page.keyboard.press('Escape')
  await editor.focus()
  await page.keyboard.press('ControlOrMeta+Home')
  await expect(editor).toContainText('# Large note')
  await expect(editor).toContainText('**markup** with Unicode: 日本語 café.')
  await page.keyboard.press('ControlOrMeta+End')
  await expect(editor).toContainText('Last line.')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editor.locator('.cm-placeholder')).toHaveText('Start writing…')
})
