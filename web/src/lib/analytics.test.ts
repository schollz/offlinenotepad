import { afterEach, describe, expect, it, vi } from 'vitest'

afterEach(() => {
  vi.resetModules()
  vi.unstubAllGlobals()
  Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: null })
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true })
  Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: false })
})

describe('privacy-bounded analytics', () => {
  it('normalizes route identifiers and carries only an opaque in-memory cache token', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ cache: 'session.cache-one' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ cache: 'session.cache-two' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }))
    vi.stubGlobal('fetch', fetchMock)
    const { trackPageView } = await import('./analytics')

    trackPageView('/app/notes/private-document-one')
    trackPageView('/app/notes/private-document-two')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))

    const first = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    const second = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as Record<string, unknown>
    expect(first).toMatchObject({ kind: 'pageview', page: 'note' })
    expect(first).not.toHaveProperty('cache')
    expect(second).toMatchObject({ kind: 'pageview', page: 'note', cache: 'session.cache-one' })
    expect(JSON.stringify([first, second])).not.toContain('private-document')
  })

  it('uses only typed event fields and suppresses disabled relays', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, {
      status: 204, headers: { 'X-Analytics-Status': 'disabled' },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { trackEvent } = await import('./analytics')

    trackEvent({ event: 'archive-import', outcome: 'error', variant: 'encrypted', reason: 'crypto' }, 'note')
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    trackEvent({ event: 'note-create', outcome: 'success' }, 'note')
    await Promise.resolve()

    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as Record<string, unknown>
    expect(body).toMatchObject({ kind: 'event', page: 'note', event: 'archive-import', outcome: 'error', variant: 'encrypted', reason: 'crypto' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('respects Do Not Track, Global Privacy Control, and offline state', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: '1' })
    let analytics = await import('./analytics')
    analytics.trackPageView('/')
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()

    vi.resetModules()
    Object.defineProperty(navigator, 'doNotTrack', { configurable: true, value: null })
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: true })
    analytics = await import('./analytics')
    analytics.trackPageView('/')
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()

    vi.resetModules()
    Object.defineProperty(navigator, 'globalPrivacyControl', { configurable: true, value: false })
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false })
    analytics = await import('./analytics')
    analytics.trackPageView('/')
    await Promise.resolve()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('swallows relay failures', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('network unavailable'))
    vi.stubGlobal('fetch', fetchMock)
    const { trackEvent } = await import('./analytics')
    expect(() => trackEvent({ event: 'note-delete', outcome: 'success' }, 'note')).not.toThrow()
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
  })
})
