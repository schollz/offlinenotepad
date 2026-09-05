export type AnalyticsPage = 'landing' | 'notebook' | 'note' | 'public-snapshot' | 'legacy-public-snapshot'
export type AnalyticsOutcome = 'success' | 'error'

type AnalyticsResult<Reason extends string> =
  | { outcome: 'success'; reason?: never }
  | { outcome: 'error'; reason: Reason }

type AnalyticsEvent =
  | ({ event: 'notebook-create' } & AnalyticsResult<'validation' | 'already-exists' | 'server' | 'crypto' | 'unknown'>)
  | ({ event: 'notebook-unlock' } & AnalyticsResult<'validation' | 'not-found' | 'incorrect-password' | 'offline-unavailable' | 'server' | 'crypto' | 'unknown'>)
  | ({ event: 'note-create' | 'note-delete' } & AnalyticsResult<'local-storage' | 'unknown'>)
  | ({ event: 'snapshot-publish'; variant: 'create' | 'update' } & AnalyticsResult<'offline-unavailable' | 'server' | 'unknown'>)
  | ({ event: 'snapshot-unpublish' } & AnalyticsResult<'offline-unavailable' | 'server' | 'unknown'>)
  | ({ event: 'archive-export'; variant: 'encrypted' | 'plaintext' } & AnalyticsResult<'local-storage' | 'unknown'>)
  | ({ event: 'archive-import'; variant: 'encrypted' | 'plaintext' | 'legacy' } & AnalyticsResult<'validation' | 'crypto' | 'local-storage' | 'unknown'>)
  | ({ event: 'password-rotate' } & AnalyticsResult<'offline-unavailable' | 'validation' | 'server' | 'crypto' | 'local-storage' | 'unknown'>)

interface AnalyticsSubmission {
  kind: 'pageview' | 'event'
  page: AnalyticsPage
  event?: AnalyticsEvent['event']
  outcome?: AnalyticsOutcome
  variant?: string
  reason?: string
  language?: string
  screen?: string
  referrer?: string
  cache?: string
}

interface NavigatorPrivacy extends Navigator {
  globalPrivacyControl?: boolean
}

interface WindowPrivacy extends Window {
  doNotTrack?: string
}

let cacheToken = ''
let relayDisabled = false
let deliveryQueue = Promise.resolve()
let nextReferrer = sanitizeReferrer(typeof document === 'undefined' ? '' : document.referrer)

export function analyticsPageForPath(pathname: string): AnalyticsPage | null {
  if (pathname === '/' || pathname === '/index.html') return 'landing'
  if (pathname === '/app') return 'notebook'
  if (/^\/app\/notes\/[^/]+$/u.test(pathname)) return 'note'
  if (/^\/p\/[^/]+$/u.test(pathname)) return 'public-snapshot'
  if (/^\/[a-f0-9]{8}$/u.test(pathname)) return 'legacy-public-snapshot'
  return null
}

function normalizedPath(page: AnalyticsPage): string {
  switch (page) {
    case 'landing': return '/'
    case 'notebook': return '/app'
    case 'note': return '/app/notes/:id'
    case 'public-snapshot': return '/p/:id'
    case 'legacy-public-snapshot': return '/:legacy-id'
  }
}

function trackingForbidden(): boolean {
  if (typeof navigator === 'undefined') return true
  const privacy = navigator as NavigatorPrivacy
  const browserWindow = window as WindowPrivacy
  return navigator.doNotTrack === '1' || browserWindow.doNotTrack === '1' || privacy.globalPrivacyControl === true
}

function sanitizeReferrer(raw: string): string {
  if (!raw || typeof location === 'undefined') return ''
  try {
    const value = new URL(raw, location.origin)
    value.search = ''
    value.hash = ''
    if (value.origin === location.origin) {
      const page = analyticsPageForPath(value.pathname)
      value.pathname = page ? normalizedPath(page) : '/'
    } else {
      value.pathname = ''
    }
    return value.toString()
  } catch {
    return ''
  }
}

function visitorFields(): Pick<AnalyticsSubmission, 'language' | 'screen'> {
  const language = /^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(navigator.language) ? navigator.language : undefined
  const width = Math.round(window.screen.width)
  const height = Math.round(window.screen.height)
  const screen = width > 0 && width < 100_000 && height > 0 && height < 100_000 ? `${width}x${height}` : undefined
  return { language, screen }
}

function enqueue(submission: AnalyticsSubmission): void {
  if (relayDisabled || trackingForbidden() || navigator.onLine === false) return
  deliveryQueue = deliveryQueue.catch(() => undefined).then(async () => {
    if (relayDisabled || trackingForbidden() || navigator.onLine === false) return
    try {
      const response = await fetch('/api/v1/analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...submission, ...visitorFields(), cache: cacheToken || undefined }),
        keepalive: true,
      })
      if (response.headers.get('X-Analytics-Status') === 'disabled') {
        relayDisabled = true
        return
      }
      if (!response.ok || response.status === 204) return
      const value = await response.json() as { cache?: unknown }
      if (typeof value.cache === 'string' && /^[A-Za-z0-9_.-]{1,4096}$/u.test(value.cache)) cacheToken = value.cache
    } catch {
      // Analytics is best-effort and must never interrupt the notebook.
    }
  })
}

export function trackPageView(pathname: string): void {
  const page = analyticsPageForPath(pathname)
  if (!page) return
  enqueue({ kind: 'pageview', page, referrer: nextReferrer || undefined })
  nextReferrer = `${location.origin}${normalizedPath(page)}`
}

export function trackEvent(event: AnalyticsEvent, page: AnalyticsPage): void {
  enqueue({ kind: 'event', page, ...event, referrer: nextReferrer || undefined })
}
