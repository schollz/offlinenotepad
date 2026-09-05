import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'
import { getLogin, notebookDB, saveLogin } from './lib/db'
import { toBase64 } from './lib/encoding'

const legacyGolden = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fzfX6+lZfj1SrH6oQDTm/W0lUoUfyuss9ergu0hTHHSea7nzW7+XEdU6+7eeJyLYuek+ylZliq76lMbEo29ZEvCnYIhxq1pIh751Lbe3hEcMwyhSnlyIME8koPNGhl68UXIpdUJr7ykBwNKzEgarX2fpvuGbSWfYd78WGL4CFadM4iTGS71oXtM1a979lvO+BBhgbqCUsaTFNQlpy3QGKBPhQHXGGZZmbCq9K6Q/MOuY7cxRsQKXKLFlIf+Vjk1kK'

beforeEach(async () => {
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
    expect(screen.getByRole('heading', { name: 'A private notepad that works offline.' })).toBeInTheDocument()
    expect(await screen.findByLabelText('Notebook name')).toHaveAttribute('autocomplete', 'username')
    expect(screen.getByLabelText('Password')).toHaveAttribute('autocomplete', 'current-password')
    expect(screen.getByText(/password never leaves this browser/i)).toBeInTheDocument()
    expect(screen.getByRole('region', { name: 'Notebook access' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open notebook' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Create' })).not.toBeInTheDocument()
    expect(screen.getByText(/new credentials create a notebook automatically/i)).toBeInTheDocument()
  })

  it('accepts a short password and attempts to create an unknown notebook', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ status: 404, ok: false })
    vi.stubGlobal('fetch', fetchMock)
    render(<MemoryRouter><App /></MemoryRouter>)
    fireEvent.change(await screen.findByLabelText('Notebook name'), { target: { value: 'legacy-account' } })
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'tiny' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open notebook' }))
    expect(await screen.findByText('This browser cannot run the encryption worker.')).toBeInTheDocument()
    const productRequests = () => fetchMock.mock.calls.filter(([input]) => String(input) !== '/api/v1/analytics')
    expect(productRequests()).toHaveLength(2)
    await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => {
      if (String(input) !== '/api/v1/analytics') return false
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      return body.event === 'notebook-create' && body.reason === 'crypto'
    })).toBe(true))

    fireEvent.change(screen.getByLabelText('Password'), { target: { value: '' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open notebook' }))
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
    fireEvent.click(screen.getByRole('button', { name: 'Open notebook' }))
    expect(await screen.findByText(/legacy username or password is incorrect/i)).toBeInTheDocument()
    const productRequests = fetchMock.mock.calls.filter(([input]) => String(input) !== '/api/v1/analytics')
    expect(productRequests).toHaveLength(2)
    expect(productRequests.some(([input]) => String(input) === '/api/v1/workspaces')).toBe(false)
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
})
