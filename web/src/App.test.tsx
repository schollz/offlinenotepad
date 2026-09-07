import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { decryptRecord, encryptRecord } from './lib/crypto'
import { documentKey, getLogin, notebookDB, saveLogin } from './lib/db'
import { toBase64 } from './lib/encoding'
import { workspacePreferencesDocumentID } from './lib/preferences'
import { SearchIndex, type SearchRequest } from './lib/search-index'
import type { PrivateRecord } from './types'

const legacyGolden = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fzfX6+lZfj1SrH6oQDTm/W0lUoUfyuss9ergu0hTHHSea7nzW7+XEdU6+7eeJyLYuek+ylZliq76lMbEo29ZEvCnYIhxq1pIh751Lbe3hEcMwyhSnlyIME8koPNGhl68UXIpdUJr7ykBwNKzEgarX2fpvuGbSWfYd78WGL4CFadM4iTGS71oXtM1a979lvO+BBhgbqCUsaTFNQlpy3QGKBPhQHXGGZZmbCq9K6Q/MOuY7cxRsQKXKLFlIf+Vjk1kK'
const legacyDeletedGolden = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fqtjxzV2F2EnjbFOnjcuNcz2d4oFma0XVG/svUjZZqpkoedIb5PC8sXNBAIKqt2LsvTkuKuh1i+HANrU5nZyNafoRp4wE2szDVBaCLWEpqntyOT5bFI4+CJjfWMNrKapd6UKMLDt23dH5ebcqMEDmfo2VyPNAuPv8cY2j0rWItp2F9k/cmJ3rTQsIqy1JBUW/qGY+itpemOEZAmjg/RtwFG30eGsGZfcTHI97lkEG4h8='

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static readonly instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.OPEN
  readonly sent: string[] = []
  private readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>()

  constructor() { FakeWebSocket.instances.push(this) }
  addEventListener(type: string, listener: (event: { data?: string }) => void): void {
    const listeners = this.listeners.get(type) ?? []
    listeners.push(listener)
    this.listeners.set(type, listeners)
  }
  emit(type: string, event: { data?: string } = {}): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event)
  }
  close(): void { this.readyState = FakeWebSocket.CLOSED }
  send(message: string): void { this.sent.push(message) }
}

class FakeWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  private key?: Uint8Array
  private workspace = ''
  private readonly index = new SearchIndex()
  constructor(private readonly url: URL) {}

  postMessage(message: { id: number; key?: Uint8Array; workspace?: string; record?: PrivateRecord } & SearchRequest): void {
    if (this.url.pathname.includes('search.worker')) {
      const ids = this.index.apply(message)
      if (ids) queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ids } } as MessageEvent))
      return
    }
    if (message.key) { this.key = message.key; this.workspace = message.workspace!; return }
    if (message.record) {
      const encrypted = encryptRecord(message.record, this.workspace, this.key!)
      queueMicrotask(() => this.onmessage?.({ data: { id: message.id, ...encrypted } } as MessageEvent))
      return
    }
    queueMicrotask(() => this.onmessage?.({ data: {
      id: message.id,
      contentKey: new Uint8Array(32).fill(8),
      authSeed: new Uint8Array(32).fill(2),
      authPublicKey: new Uint8Array(32).fill(3),
    } } as MessageEvent))
  }
  terminate(): void {}
}

beforeEach(async () => {
  vi.stubGlobal('Worker', FakeWorker)
  FakeWebSocket.instances.length = 0
  await notebookDB.accounts.clear()
  await notebookDB.documents.clear()
  await notebookDB.outbox.clear()
  await notebookDB.logins.clear()
})

afterEach(async () => {
  cleanup()
  await notebookDB.accounts.clear()
  await notebookDB.documents.clear()
  await notebookDB.outbox.clear()
  await notebookDB.logins.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('landing and notebook access experience', () => {
  it('presents one accessible open-or-create credential flow', async () => {
    render(<MemoryRouter><App /></MemoryRouter>)
    expect(screen.getByRole('heading', { name: 'Sign in or create a notebook' })).toBeInTheDocument()
    expect(await screen.findByLabelText('Notebook name')).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText('Notebook name')).toHaveFocus()
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
    expect(screen.getByText(/password never leaves this browser/i)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Sign in or create a notebook' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Sign in or create notebook' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Welcome to the Offline Notepad.' })).toBeInTheDocument()
    expect(screen.getByText(/offline-capable note-writing app/i)).toBeInTheDocument()
    expect(screen.getByText(/automatically sync with a server using end-to-end encryption/i)).toBeInTheDocument()
    expect(screen.getAllByRole('link', { name: 'open-source' })[0]).toHaveAttribute('href', 'https://github.com/schollz/offlinenotepad')
    expect(screen.getByRole('link', { name: 'About' })).toHaveAttribute('href', '/about')
    expect(screen.getByRole('link', { name: 'Blog' })).toHaveAttribute('href', '/blog')
    expect(screen.getByRole('link', { name: 'Contact' })).toHaveAttribute('href', '/contact')
    expect(screen.getByText(/made by/i)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'github' })).toHaveAttribute('href', 'https://github.com/schollz/offlinenotepad')
    expect(screen.getByText('other tools')).toBeInTheDocument()
  })

  it('toggles password visibility from the password field', async () => {
    render(<MemoryRouter><App /></MemoryRouter>)
    const password = await screen.findByLabelText('Password')
    expect(password).toHaveAttribute('type', 'password')

    fireEvent.click(screen.getByRole('button', { name: 'Show password' }))
    expect(password).toHaveAttribute('type', 'text')
    expect(screen.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true')

    fireEvent.click(screen.getByRole('button', { name: 'Hide password' }))
    expect(password).toHaveAttribute('type', 'password')
    expect(screen.getByRole('button', { name: 'Show password' })).toHaveAttribute('aria-pressed', 'false')
  })

  it('accepts a short password and attempts to create an unknown notebook', async () => {
    vi.stubGlobal('Worker', undefined)
    const fetchMock = vi.fn().mockResolvedValue({ status: 404, ok: false })
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryRouter><App /></MemoryRouter>)
    fireEvent.change(await screen.findByLabelText('Notebook name'), { target: { value: 'legacy-account' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'tiny' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in or create notebook' }))
    expect(await screen.findByText('This browser cannot run the encryption worker.')).toBeInTheDocument()
    const productRequests = () => fetchMock.mock.calls.filter(([input]) => String(input) !== '/api/v1/analytics')
    expect(productRequests()).toHaveLength(2)
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => {
      if (String(input) !== '/api/v1/analytics') return false
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return body.event === 'notebook-create' && body.reason === 'crypto'
    })).toBe(true))

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in or create notebook' }))
    expect(await screen.findByText('Enter your password.')).toBeInTheDocument()
    expect(productRequests()).toHaveLength(2)
    const telemetry = fetchMock.mock.calls
      .filter(([input]) => String(input) === '/api/v1/analytics')
      .map(([, init]) => String(init?.body))
      .join('\n')
    expect(telemetry).not.toContain('legacy-account')
    expect(telemetry).not.toContain('tiny')
    expect(telemetry).not.toContain('encryption worker')
  })

  it('never replaces a staged legacy notebook when its password is wrong', async () => {
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/analytics') {
        return Promise.resolve({ status: 204, ok: true, headers: { get: () => null } })
      }
      if (String(input).startsWith('/api/v1/legacy/workspaces/')) return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve({
          legacy_id: '778b180d',
          documents: [{ document_id: 'abc12345', ciphertext: legacyGolden, document_hash: 'bb33cf65' }],
        }),
      })
      return Promise.resolve({ status: 404, ok: false })
    })
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryRouter><App /></MemoryRouter>)
    fireEvent.change(await screen.findByLabelText('Notebook name'), { target: { value: 'migration-integration-workspace' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'wrong' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in or create notebook' }))
    expect(await screen.findByText(/legacy username or password is incorrect/i)).toBeInTheDocument()
    const productRequests = fetchMock.mock.calls.filter(([input]) => String(input) !== '/api/v1/analytics')
    expect(productRequests).toHaveLength(2)
    expect(productRequests.some(([input]) => String(input) === '/api/v1/workspaces')).toBe(false)
  })

  it('promotes valid legacy notes while accounting for unreadable records', async () => {
    let promotionBody: Record<string, unknown> | undefined
    const fetchMock = vi.fn().mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const target = String(input)
      if (target === '/api/v1/analytics') return Promise.resolve({ status: 204, ok: true, headers: { get: () => null } })
      if (target.startsWith('/api/v1/workspaces/')) return Promise.resolve({ status: 404, ok: false })
      if (target.startsWith('/api/v1/legacy/workspaces/') && init?.method === 'POST') {
        promotionBody = JSON.parse(String(init.body)) as Record<string, unknown>
        return Promise.resolve({ status: 201, ok: true })
      }
      if (target.startsWith('/api/v1/legacy/workspaces/')) return Promise.resolve({
        status: 200,
        ok: true,
        json: () => Promise.resolve({
          legacy_id: '778b180d',
          documents: [
            { document_id: 'abc12345', ciphertext: legacyGolden, document_hash: 'bb33cf65' },
            { document_id: 'del12345', ciphertext: legacyDeletedGolden, document_hash: '3855f5d9' },
            { document_id: 'damaged1', ciphertext: `${'0'.repeat(64)}invalid`, document_hash: 'deadbeef' },
          ],
        }),
      })
      return Promise.resolve({ status: 500, ok: false })
    })
    vi.stubGlobal('fetch', fetchMock)
    vi.stubGlobal('Worker', FakeWorker)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true)

    render(<MemoryRouter><App /></MemoryRouter>)
    fireEvent.change(await screen.findByLabelText('Notebook name'), { target: { value: 'migration-integration-workspace' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'correct horse battery staple' } })
    fireEvent.click(screen.getByRole('button', { name: 'Sign in or create notebook' }))

    expect(await screen.findByText('Golden note')).toBeInTheDocument()
    expect(promotionBody).toMatchObject({ rejected_document_ids: ['damaged1'] })
    expect(promotionBody).toMatchObject({ discarded_document_ids: ['del12345'] })
    expect(promotionBody?.documents).toHaveLength(1)
    expect(await screen.findByText(/Omitted 1 legacy deletion marker/u)).toBeInTheDocument()
    expect(await screen.findByText(/Skipped 1 unreadable legacy record/u)).toBeInTheDocument()
  })

  it('opens a saved browser login automatically and forgets it on logout', async () => {
    const authPublicKey = new Uint8Array(32).fill(3)
    await saveLogin({
      username: 'remembered-notebook',
      metadata: {
        id: 'remembered-workspace',
        kdf_version: 1,
        kdf_salt: 'salt',
        kdf_memory: 65_536,
        kdf_iterations: 3,
        kdf_parallelism: 1,
        auth_public_key: toBase64(authPublicKey),
      },
      keys: {
        contentKey: new Uint8Array(32).fill(1),
        authSeed: new Uint8Array(32).fill(2),
        authPublicKey,
      },
    })
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)

    render(<MemoryRouter><App /></MemoryRouter>)
    expect(await screen.findByRole('button', { name: 'Create your first note' })).toBeInTheDocument()
    expect(screen.queryByLabelText('Notebook name')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'More options' }))
    fireEvent.click(screen.getByRole('button', { name: /Log out/ }))
    expect(await screen.findByLabelText('Notebook name')).toBeInTheDocument()
    await waitFor(async () => expect(await getLogin()).toBeUndefined())
  })

  it('shows a loader instead of the empty-workspace prompt while connecting', async () => {
    const authPublicKey = new Uint8Array(32).fill(3)
    const metadata = {
      id: 'connecting-workspace',
      kdf_version: 1,
      kdf_salt: 'salt',
      kdf_memory: 65_536,
      kdf_iterations: 3,
      kdf_parallelism: 1,
      auth_public_key: toBase64(authPublicKey),
    }
    await saveLogin({
      username: 'connecting-notebook',
      metadata,
      keys: {
        contentKey: new Uint8Array(32).fill(1),
        authSeed: new Uint8Array(32).fill(2),
        authPublicKey,
      },
    })
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/analytics') return Promise.resolve({ status: 204, ok: true, headers: { get: () => null } })
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(metadata) })
    }))

    render(<MemoryRouter><App /></MemoryRouter>)

    const connecting = await screen.findByRole('status', { name: 'Connecting to your notebook' })
    expect(connecting.querySelector('.loader')).toBeInTheDocument()
    expect(screen.queryByText('Capture what matters.')).not.toBeInTheDocument()

    FakeWebSocket.instances[0].emit('message', { data: JSON.stringify({
      type: 'authenticated', documents: [], publications: [],
    }) })

    expect(await screen.findByRole('button', { name: 'Create your first note' })).toBeInTheDocument()
    expect(screen.queryByRole('status', { name: 'Connecting to your notebook' })).not.toBeInTheDocument()
  })

  it('restores and updates the encrypted last-opened note preference through synchronization', async () => {
    const workspaceId = 'remembered-note-workspace'
    const contentKey = new Uint8Array(32).fill(8)
    const authPublicKey = new Uint8Array(32).fill(3)
    const metadata = {
      id: workspaceId,
      kdf_version: 1,
      kdf_salt: 'salt',
      kdf_memory: 65_536,
      kdf_iterations: 3,
      kdf_parallelism: 1,
      auth_public_key: toBase64(authPublicKey),
    }
    await saveLogin({
      username: 'remembered-note-notebook', metadata,
      keys: { contentKey, authSeed: new Uint8Array(32).fill(2), authPublicKey },
    })
    const timestamp = '2026-09-06T13:00:00.000Z'
    const records = [
      { id: 'newer-note', title: 'Newer note', content: '', mode: 'markdown' as const, folder_id: null, created_at: timestamp, updated_at: timestamp },
      { id: 'older-note', title: 'Last opened note', content: '', mode: 'markdown' as const, folder_id: null, created_at: timestamp, updated_at: '2026-09-06T12:00:00.000Z' },
      { record_type: 'workspace_preferences' as const, id: workspacePreferencesDocumentID, last_opened_note_id: 'older-note', updated_at: timestamp },
    ]
    const documents = records.map((record) => {
      const encrypted = encryptRecord(record, workspaceId, contentKey)
      return {
        document_id: record.id, ciphertext: encrypted.ciphertext, ciphertext_hash: encrypted.hash,
        revision: record.id === workspacePreferencesDocumentID ? 2 : 1,
        deleted: false, updated_at: record.updated_at,
      }
    })
    await notebookDB.documents.bulkPut(documents.map((document) => ({
      key: documentKey(workspaceId, document.document_id), workspaceId, documentId: document.document_id,
      ciphertext: document.ciphertext, ciphertextHash: document.ciphertext_hash, revision: document.revision,
      deleted: document.deleted, updatedAt: document.updated_at, pending: false,
    })))
    const stalePreferences = encryptRecord({
      record_type: 'workspace_preferences', id: workspacePreferencesDocumentID,
      last_opened_note_id: 'newer-note', updated_at: '2026-09-06T11:00:00.000Z',
    }, workspaceId, contentKey)
    await notebookDB.documents.put({
      key: documentKey(workspaceId, workspacePreferencesDocumentID), workspaceId, documentId: workspacePreferencesDocumentID,
      ciphertext: stalePreferences.ciphertext, ciphertextHash: stalePreferences.hash, revision: 1,
      deleted: false, updatedAt: '2026-09-06T11:00:00.000Z', pending: false,
    })
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/analytics') return Promise.resolve({ status: 204, ok: true, headers: { get: () => null } })
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(metadata) })
    }))

    render(<MemoryRouter initialEntries={['/app']}><App /></MemoryRouter>)
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    expect(await screen.findByDisplayValue('Newer note')).toBeInTheDocument()
    FakeWebSocket.instances[0].emit('message', { data: JSON.stringify({
      type: 'authenticated', documents, publications: [],
    }) })
    expect(await screen.findByDisplayValue('Last opened note')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Newer note' }))
    await waitFor(() => {
      const messages = FakeWebSocket.instances[0].sent.map((message) => JSON.parse(message) as Record<string, unknown>)
      expect(messages).toContainEqual(expect.objectContaining({ type: 'upsert', document_id: workspacePreferencesDocumentID }))
      const update = messages.find((message) => message.document_id === workspacePreferencesDocumentID)
      expect(String(update?.ciphertext)).not.toContain('newer-note')
      expect(update?.base_revision).toBe(2)
      expect(decryptRecord(String(update?.ciphertext), workspaceId, workspacePreferencesDocumentID, contentKey)).toMatchObject({
        record_type: 'workspace_preferences', last_opened_note_id: 'newer-note',
      })
    })
  })

  it('repairs an unreadable synced cache record from the authenticated server', async () => {
    const workspaceId = 'cache-recovery-workspace'
    const documentId = 'document-one'
    const contentKey = new Uint8Array(32).fill(8)
    const authPublicKey = new Uint8Array(32).fill(3)
    const metadata = {
      id: workspaceId,
      kdf_version: 1,
      kdf_salt: 'salt',
      kdf_memory: 65_536,
      kdf_iterations: 3,
      kdf_parallelism: 1,
      auth_public_key: toBase64(authPublicKey),
    }
    await saveLogin({
      username: 'cache-recovery-notebook',
      metadata,
      keys: { contentKey, authSeed: new Uint8Array(32).fill(2), authPublicKey },
    })
    await notebookDB.documents.put({
      key: documentKey(workspaceId, documentId), workspaceId, documentId,
      ciphertext: 'unreadable-cache', ciphertextHash: 'unreadable-cache', revision: 7,
      deleted: false, updatedAt: new Date().toISOString(), pending: false,
    })
    const note = {
      id: documentId, title: 'Recovered from server', content: 'safe encrypted content', mode: 'markdown' as const,
      created_at: '2026-09-05T14:30:00.000Z', updated_at: '2026-09-05T14:30:00.000Z',
    }
    const encrypted = encryptRecord(note, workspaceId, contentKey)
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(true)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    vi.stubGlobal('fetch', vi.fn().mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === '/api/v1/analytics') return Promise.resolve({ status: 204, ok: true, headers: { get: () => null } })
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve(metadata) })
    }))

    render(<MemoryRouter><App /></MemoryRouter>)
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    FakeWebSocket.instances[0].emit('message', { data: JSON.stringify({
      type: 'authenticated',
      documents: [{
        document_id: documentId, ciphertext: encrypted.ciphertext, ciphertext_hash: encrypted.hash,
        revision: 1, deleted: false, updated_at: note.updated_at,
      }],
      publications: [],
    }) })

    expect(await screen.findByText('Recovered from server')).toBeInTheDocument()
    const recovered = await notebookDB.documents.get(documentKey(workspaceId, documentId))
    expect(recovered).toMatchObject({ ciphertextHash: encrypted.hash, revision: 1, pending: false })
  })

  it('creates a folder and saves a new note inside it before synchronization', async () => {
    const contentKey = new Uint8Array(32).fill(8)
    const authPublicKey = new Uint8Array(32).fill(3)
    await saveLogin({
      username: 'folder-notebook',
      metadata: {
        id: 'folder-workspace', kdf_version: 1, kdf_salt: 'salt', kdf_memory: 65_536,
        kdf_iterations: 3, kdf_parallelism: 1, auth_public_key: toBase64(authPublicKey),
      },
      keys: { contentKey, authSeed: new Uint8Array(32).fill(2), authPublicKey },
    })
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)

    render(<MemoryRouter><App /></MemoryRouter>)
    expect(await screen.findByRole('button', { name: 'Create your first note' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'New folder' }))
    fireEvent.change(screen.getByLabelText('Folder name'), { target: { value: 'Projects' } })
    fireEvent.click(screen.getAllByRole('button', { name: /^New folder$/u }).at(-1)!)
    expect(await screen.findByRole('button', { name: /^Projects$/u })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /^Projects$/u }))
    fireEvent.click(screen.getByRole('button', { name: 'New note' }))
    fireEvent.change(await screen.findByLabelText('Note title'), { target: { value: 'Launch plan' } })

    await waitFor(async () => {
      const documents = await notebookDB.documents.where('workspaceId').equals('folder-workspace').toArray()
      const records = documents.map((document) => decryptRecord(document.ciphertext, 'folder-workspace', document.documentId, contentKey))
      const folder = records.find((record) => 'record_type' in record && record.record_type === 'folder')
      const note = records.find((record) => !('record_type' in record))
      expect(folder).toMatchObject({ name: 'Projects' })
      expect(note).toMatchObject({ title: 'Launch plan', folder_id: folder?.id })
      expect(documents.every((document) => document.pending)).toBe(true)
    })
    expect(screen.getByText('Saved offline', { exact: true })).toBeInTheDocument()
  })

  it('deletes a Shift-selected range of notes in one bulk action', async () => {
    const workspaceId = 'bulk-selection-workspace'
    const contentKey = new Uint8Array(32).fill(8)
    const authPublicKey = new Uint8Array(32).fill(3)
    await saveLogin({
      username: 'bulk-selection-notebook',
      metadata: {
        id: workspaceId, kdf_version: 1, kdf_salt: 'salt', kdf_memory: 65_536,
        kdf_iterations: 3, kdf_parallelism: 1, auth_public_key: toBase64(authPublicKey),
      },
      keys: { contentKey, authSeed: new Uint8Array(32).fill(2), authPublicKey },
    })
    const timestamp = '2026-09-06T12:00:00.000Z'
    const documents = ['Charlie', 'Alpha', 'Bravo'].map((title) => {
      const id = title.toLowerCase()
      const encrypted = encryptRecord({
        id, title, content: '', mode: 'markdown' as const, folder_id: null,
        created_at: timestamp, updated_at: timestamp,
      }, workspaceId, contentKey)
      return {
        key: documentKey(workspaceId, id), workspaceId, documentId: id,
        ciphertext: encrypted.ciphertext, ciphertextHash: encrypted.hash, revision: 1,
        deleted: false, updatedAt: timestamp, pending: false,
      }
    })
    await notebookDB.documents.bulkPut(documents)
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false)
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)

    render(<MemoryRouter><App /></MemoryRouter>)
    fireEvent.click(await screen.findByRole('button', { name: 'Alpha' }))
    fireEvent.click(screen.getByRole('button', { name: 'Charlie' }), { shiftKey: true })
    expect(screen.getByRole('toolbar', { name: '3 selected notes' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Delete' }))

    await waitFor(async () => {
      const stored = await notebookDB.documents.where('workspaceId').equals(workspaceId).toArray()
      const storedNotes = stored.filter((document) => document.documentId !== workspacePreferencesDocumentID)
      expect(storedNotes).toHaveLength(3)
      expect(storedNotes.every((document) => document.deleted && document.pending)).toBe(true)
      expect(stored.find((document) => document.documentId === workspacePreferencesDocumentID)).toMatchObject({ deleted: false, pending: true })
      expect(await notebookDB.outbox.where('workspaceId').equals(workspaceId).count()).toBe(4)
    })
    expect(confirm).toHaveBeenCalledWith('Permanently delete 3 selected notes from every synced device?')
    expect(screen.queryByRole('button', { name: 'Alpha' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Bravo' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Charlie' })).not.toBeInTheDocument()
  })
})
