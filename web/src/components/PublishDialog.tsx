import { useEffect, useRef, useState } from 'react'
import type { PublicationRenderMode } from '../types'

interface Props {
  initialMode: PublicationRenderMode
  updating: boolean
  onClose: () => void
  onPublish: (mode: PublicationRenderMode) => Promise<void>
}

export function PublishDialog({ initialMode, updating, onClose, onPublish }: Props) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [mode, setMode] = useState(initialMode)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const element = dialog.current!
    element.showModal()
    return () => element.close()
  }, [])

  async function submit() {
    setBusy(true)
    setError('')
    try {
      await onPublish(mode)
      onClose()
    } catch {
      setError('The snapshot could not be published. Check your connection and local save status, then try again.')
      setBusy(false)
    }
  }

  return <dialog ref={dialog} className="dialog publish-dialog" aria-labelledby="publish-title" onCancel={(event) => { event.preventDefault(); if (!busy) onClose() }}>
    <h2 id="publish-title">{updating ? 'Update public snapshot' : 'Publish a snapshot'}</h2>
    <p>Anyone with the link can read this snapshot. Later private edits are shared only when you publish again.</p>
    <label htmlFor="publication-format">Published format</label>
    <select id="publication-format" autoFocus value={mode} disabled={busy} onChange={(event) => setMode(event.target.value as PublicationRenderMode)}>
      <option value="document">Current note format</option>
      <option value="html">HTML page</option>
      <option value="markdown-html">Markdown with HTML</option>
    </select>
    {mode !== 'document' && <p className="publication-explanation">This format runs JavaScript and can load external libraries or contact HTTPS services. It runs separately from your private notebook. Browser storage, popups, and embedded frames are unavailable.</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      <button className="button secondary" disabled={busy} onClick={onClose}>Cancel</button>
      <button className="button primary" disabled={busy} onClick={() => void submit()}>{busy ? 'Publishing…' : updating ? 'Update snapshot' : 'Publish snapshot'}</button>
    </div>
  </dialog>
}
