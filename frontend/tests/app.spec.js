import { test, expect } from '@playwright/test';
import { encrypted, password } from './legacy-fixture.js';
import { decode } from '../src/crypto.js';

async function login(page, username = 'test-' + crypto.randomUUID(), pass = password) {
  await page.goto('/');
  await page.locator('#loginUser').fill(username);
  await page.locator('#loginPass').fill(pass);
  await page.locator('#loginLink').click();
  await expect(page.locator('#newlink')).toBeVisible();
  return username;
}

async function writeNote(page, title, markdown) {
  await page.locator('#newlink').click();
  await page.locator('#edittitle').fill(title);
  await page.locator('#editable').fill(markdown);
  // Navigating immediately must flush the pending autosave.
  await page.locator('#viewlink').click();
  await expect(page.locator('main h1').first()).toHaveText(title);
}

test('keeps the welcome layout and Lucide controls on desktop and mobile', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('main')).toHaveCSS('max-width', '620px');
  await expect(page.locator('main')).toHaveCSS('font-family', '"Times New Roman", Times, serif');
  await expect(page.locator('#loginLink svg')).toHaveClass(/lucide/);
  await expect(page.getByText('Welcome to the Offline Notepad.')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#loginLink')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test('loads existing encrypted browser notes and survives a reload', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(value => localStorage.setItem('localforage/legacy01', JSON.stringify(value)), encrypted);
  await login(page);
  await page.locator('#legacy01').click();
  await expect(page.getByText('Encrypted café notes 🔒')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Encrypted café notes 🔒')).toBeVisible();
  await expect(page.locator('#editlink')).toBeVisible();
});

test('edits, previews, searches, exports, and deletes without losing pending changes', async ({ page }) => {
  await login(page);
  await writeNote(page, 'Migration sample', '# Hello\n\nA **bold** note with a [link](https://example.com).\n\n- First item\n- Second item');
  await expect(page.locator('main strong')).toHaveText('bold');
  await page.locator('#editlink').click();
  await page.locator('#editable').fill('Searchable words\nTabs');
  await page.locator('#editable').press('End');
  await page.locator('#editable').press('Tab');
  await page.locator('#listlink').click();
  await page.locator('#searfhbarLink').click();
  await page.locator('#searchbar').fill('searchable');
  await expect(page.locator('.snippet mark')).toHaveText('Searchable');
  await page.locator('#searchbar').fill('title:');
  await expect(page.getByText("Found 0 items that match 'title:':")).toBeVisible();
  await page.locator('#searchbar').fill('');
  await expect(page.getByText('Migration sample')).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportlink').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  const docs = Object.values(JSON.parse(Buffer.concat(chunks).toString()));
  expect(docs[0].markdown).toContain('Tabs\t');
  await page.getByText('Migration sample', { exact: true }).click();
  await page.locator('#editlink').click();
  await page.locator('#deletelink').click();
  await page.getByRole('button', { name: 'erase note', exact: true }).click();
  await expect(page.locator('#newlink')).toBeVisible();
  await expect(page.getByText('Migration sample')).toHaveCount(0);
});

test('code titles, history, and logout retain the existing behavior', async ({ page }) => {
  await login(page);
  await writeNote(page, 'sample.go', '<hello>\n\t**plain text**');
  await expect(page.locator('main pre')).toHaveText('<hello>\n\t**plain text**');
  await expect(page.locator('main .iscode')).toBeVisible();
  await page.locator('#listlink').click();
  await page.goBack();
  await expect(page.locator('main pre')).toBeVisible();
  await page.locator('#listlink').click();
  await page.locator('#logoutlink').click();
  await page.getByRole('button', { name: 'log out', exact: true }).click();
  await expect(page.locator('#loginUser')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('app.p'))).toBeNull();
  await page.reload();
  await expect(page.locator('#loginUser')).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('app.p'))).toBeNull();
});

test('syncs across devices, publishes React pages, and preserves raw links', async ({ page, browser }) => {
  const username = await login(page);
  await writeNote(page, 'Published sample', 'Public **content**');
  const other = await browser.newContext({ baseURL: 'http://localhost:8253' });
  try {
    const secondPage = await other.newPage();
    await login(secondPage, username);
    await expect(secondPage.getByText('Published sample')).toBeVisible();
    await page.locator('#publislink').click();
    await page.getByRole('button', { name: 'publish note', exact: true }).click();
    await expect(page.locator('#publiclink')).toBeVisible();
    const href = await page.locator('#publiclink').getAttribute('href');
    await secondPage.goto(href);
    await expect(secondPage.locator('main h1')).toHaveText('Published sample');
    await expect(secondPage.locator('main strong')).toHaveText('content');
    await expect(secondPage.locator('.topbar')).toHaveCount(0);
    const raw = await page.request.get(href + '/raw');
    expect(await raw.text()).toBe('Public **content**');
    const html = await page.request.get(href);
    expect(await html.text()).toContain('id="app-data"');
  } finally { await other.close(); }
});

test('reloads and edits offline, then reconciles changes after reconnecting', async ({ page, context, browser }) => {
  const username = await login(page);
  await writeNote(page, 'Offline sample', 'Before disconnect');
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await page.locator('#editlink').click();
  await page.locator('#editable').fill('Written offline');
  await page.locator('#viewlink').click();
  await page.reload();
  await expect(page.getByText('Written offline')).toBeVisible();
  await context.setOffline(false);
  // Check ciphertext at rest and synchronize to a genuinely separate device.
  const encoded = await page.evaluate(() => Object.entries(localStorage).find(([key]) => key.startsWith('localforage/'))[1]);
  expect(encoded).not.toContain('Written offline');
  expect(JSON.parse(decode(JSON.parse(encoded), password)).markdown).toBe('Written offline');
  const other = await browser.newContext({ baseURL: 'http://localhost:8253' });
  try {
    const secondPage = await other.newPage();
    await login(secondPage, username);
    await expect(secondPage.getByText('Offline sample')).toBeVisible();
    await secondPage.getByText('Offline sample').click();
    await expect(secondPage.getByText('Written offline')).toBeVisible({ timeout: 15000 });
  } finally { await other.close(); }
});

test('returning users unlock notes in the login bar', async ({ page }) => {
  const username = await login(page);
  await writeNote(page, 'Locked note', 'Only open after entering a password');
  await page.addInitScript(() => sessionStorage.removeItem('app.p'));
  await page.reload();
  await expect(page.locator('#loginUser')).toHaveValue(username);
  await expect(page.locator('#loginPass')).toBeFocused();
  await expect(page.getByText(`Welcome back, ${username}.`)).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.locator('#loginPass').fill(password);
  await page.locator('#loginPass').press('Enter');
  await expect(page.getByText('Only open after entering a password')).toBeVisible();
});

test('inline confirmations cancel with Escape and never erase a different note', async ({ page }) => {
  await login(page);
  await writeNote(page, 'Keep this note', 'Still here');
  await page.locator('#editlink').click();
  await page.locator('#deletelink').click();
  await expect(page.getByRole('region', { name: 'Erase this note?' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Erase this note?' })).toBeFocused();
  await expect(page.locator('#editable')).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('.inline-feedback')).toHaveCount(0);
  await expect(page.locator('#deletelink')).toBeFocused();
  await page.locator('#deletelink').click();
  await page.getByRole('button', { name: 'cancel', exact: true }).click();
  await expect(page.locator('#deletelink')).toBeFocused();
  await page.locator('#deletelink').click();
  await page.locator('#listlink').click();
  await expect(page.locator('.inline-feedback')).toHaveCount(0);
  await expect(page.getByText('Keep this note', { exact: true })).toBeVisible();
  await writeNote(page, 'Another note', 'Also still here');
  await expect(page.getByRole('button', { name: 'erase note', exact: true })).toHaveCount(0);
});

test('logout and clearing local notes require explicit inline confirmation', async ({ page }) => {
  await login(page);
  await writeNote(page, 'Local note', 'Keep until confirmed');
  await page.locator('#listlink').click();
  await page.locator('#logoutlink').click();
  await page.getByRole('button', { name: 'cancel', exact: true }).click();
  await expect(page.getByText('Local note', { exact: true })).toBeVisible();
  await page.locator('#logoutlink').click();
  await page.getByRole('button', { name: 'log out', exact: true }).click();
  await page.locator('#clearlink').click();
  await expect(page.getByText(/changes that have not synced will be lost/)).toBeVisible();
  await page.getByRole('button', { name: 'cancel', exact: true }).click();
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('localforage/')).length)).toBe(1);
  await page.locator('#clearlink').click();
  await page.getByRole('button', { name: 'clear local notes', exact: true }).click();
  await expect(page.locator('#clearlink')).toHaveCount(0);
  expect(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('localforage/')).length)).toBe(0);
});

test('publishing can be cancelled and offline failures appear inline', async ({ page, context }) => {
  await login(page);
  await writeNote(page, 'Private note', 'Unpublished content');
  await page.locator('#publislink').click();
  await page.getByRole('button', { name: 'cancel', exact: true }).click();
  await expect(page.locator('#publiclink')).toHaveCount(0);
  await page.evaluate(() => navigator.serviceWorker.ready);
  await expect.poll(() => page.evaluate(() => Boolean(navigator.serviceWorker.controller))).toBe(true);
  await context.setOffline(true);
  await page.reload();
  await page.locator('#publislink').click();
  await page.getByRole('button', { name: 'publish note', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Unable to publish.');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByText('Unpublished content')).toBeVisible();
  await page.getByRole('button', { name: 'dismiss', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
