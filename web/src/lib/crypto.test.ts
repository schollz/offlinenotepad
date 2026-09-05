import { describe, expect, it } from 'vitest'
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { decryptNote, encryptNote, normalizeUsername, signChallenge, workspaceID } from './crypto'
import { encoder, fromBase64, toBase64 } from './encoding'
import { deriveKeyMaterial } from './key-material'

const golden = {
  workspace: 'ZKAbCLohP9bDxYv8F-5uXLSAD55bLNOQ-ZrNyeeV0qk',
  salt: 'AAECAwQFBgcICQoLDA0ODw',
  contentKey: '5riFm3YHip7fCvxVtHla8XgV2owKF4VGv-JFYtjjRTA',
  authSeed: '2CUAduyNnuLMa0EgyQLDTR9t4WNJFreOoJ0nGh8mZv8',
  authPublicKey: 'wonTPGWv1iVSbqQNuRN9RuUEiAJR0ToR05VF99uxAC0',
}

const goldenEnvelope = `-----BEGIN OFFLINE NOTEPAD DOCUMENT V2-----
{"v":2,"cipher":"xchacha20-poly1305","nonce":"AAECAwQFBgcICQoLDA0ODxAREhMUFRYX","data":"FJ8z4ZRuUXjD0xryMcUo00w9B2HIiHMHY-FHW5xdGUksD0wtMnz20AwFK6TBh2xtuZ3D6RRTEpWCqt5N8WPWb8lcy44EbQV4LxIR4RJKliY16EuFTdOIFlmCz8XW4kU9RXtnyyQnf167ETKGNW7acBpENQnZu7vDHUDC0Kh3X4d5SMu441QvK6MSMjrDLVFDN39bG54OeDa2GhQoXW87pWg"}
-----END OFFLINE NOTEPAD DOCUMENT V2-----`

describe('zero-knowledge cryptography', () => {
  it('matches the Go key-derivation golden values', () => {
    expect(normalizeUsername('  Example Notebook  ')).toBe('example notebook')
    expect(workspaceID('  Example Notebook  ')).toBe(golden.workspace)
    const keys = deriveKeyMaterial('correct horse battery staple', fromBase64(golden.salt), 65_536, 3, 1)
    expect(toBase64(keys.contentKey)).toBe(golden.contentKey)
    expect(toBase64(keys.authSeed)).toBe(golden.authSeed)
    expect(toBase64(keys.authPublicKey)).toBe(golden.authPublicKey)
    expect(signChallenge('AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8', keys.authSeed)).toBe('4WpN3lRjpjSpblbDSC3BqVGWiQM5G3-uuY3rWIeQXUWu3Ej5wlBOpuFNskQqjRDsKF8NLob-lUmIpaLonDX_DQ')
  })

  it('round trips an authenticated encrypted note', () => {
    const keys = deriveKeyMaterial('correct horse battery staple', fromBase64(golden.salt), 32_768, 1, 1)
    const note = { id: 'abc12345', title: 'Private', content: '# Hello', mode: 'markdown' as const, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' }
    const encrypted = encryptNote(note, golden.workspace, keys.contentKey)
    expect(encrypted.ciphertext).not.toContain(note.content)
    expect(decryptNote(encrypted.ciphertext, golden.workspace, note.id, keys.contentKey)).toEqual(note)
    expect(() => decryptNote(encrypted.ciphertext, golden.workspace, 'different', keys.contentKey)).toThrow()
  })

  it('matches the Go encrypted-envelope golden byte for byte', () => {
    const note = { id: 'abc12345', title: 'Private', content: '# Hello', mode: 'markdown' as const, created_at: '2020-01-01T00:00:00Z', updated_at: '2020-01-01T00:00:00Z' }
    const nonce = Uint8Array.from({ length: 24 }, (_, index) => index)
    const aad = encoder.encode(`offlinenotepad document v2\u0000${golden.workspace}\u0000${note.id}`)
    const data = xchacha20poly1305(fromBase64(golden.contentKey), nonce, aad).encrypt(encoder.encode(JSON.stringify(note)))
    const envelope = `-----BEGIN OFFLINE NOTEPAD DOCUMENT V2-----\n${JSON.stringify({ v: 2, cipher: 'xchacha20-poly1305', nonce: toBase64(nonce), data: toBase64(data) })}\n-----END OFFLINE NOTEPAD DOCUMENT V2-----`
    expect(envelope).toBe(goldenEnvelope)
    expect(toBase64(sha256(encoder.encode(envelope)))).toBe('h5SKi9JSzYZ6I3aze1dJAnNsTI2O4nHhSKq1MSTrI0A')
    expect(decryptNote(goldenEnvelope, golden.workspace, note.id, fromBase64(golden.contentKey))).toEqual(note)
  })
})
