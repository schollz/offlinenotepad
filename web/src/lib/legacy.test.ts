import { cbc } from '@noble/ciphers/aes.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { describe, expect, it } from 'vitest'
import { encoder, fromBase64 } from './encoding'
import { decryptLegacyWorkspace, legacyWorkspaceID, parseLegacyWorkspace } from './legacy'

const legacyGolden = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fzfX6+lZfj1SrH6oQDTm/W0lUoUfyuss9ergu0hTHHSea7nzW7+XEdU6+7eeJyLYuek+ylZliq76lMbEo29ZEvCnYIhxq1pIh751Lbe3hEcMwyhSnlyIME8koPNGhl68UXIpdUJr7ykBwNKzEgarX2fpvuGbSWfYd78WGL4CFadM4iTGS71oXtM1a979lvO+BBhgbqCUsaTFNQlpy3QGKBPhQHXGGZZmbCq9K6Q/MOuY7cxRsQKXKLFlIf+Vjk1kK'
const legacyShortPasswordGolden = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fBdsehS8hkZAmv6Km/qNel77CgUp3GqVh+nkt82lzkfsCLhcozQ69iqUzGRmHxFxN1+VNYMOsJTuBNrR/AAJbuA1v2lG8Sinx3DFnFZYjpRT/VEEWhN+Y2/FuSlZ3MA+BgrnfNC/OWKlyQLPnOTR5qtjo8dF4leEIBhMGhQ/eb8hVx81pconDVtOG3RWvgsZ64assh4stogsFg1h9qbtsTdxcZZHHzEsp0DaUjLf1Wbf9hpC9j5tG/Vt+7VgdwhFO'
const legacyDeletedGolden = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fqtjxzV2F2EnjbFOnjcuNcz2d4oFma0XVG/svUjZZqpkoedIb5PC8sXNBAIKqt2LsvTkuKuh1i+HANrU5nZyNafoRp4wE2szDVBaCLWEpqntyOT5bFI4+CJjfWMNrKapd6UKMLDt23dH5ebcqMEDmfo2VyPNAuPv8cY2j0rWItp2F9k/cmJ3rTQsIqy1JBUW/qGY+itpemOEZAmjg/RtwFG30eGsGZfcTHI97lkEG4h8='

function withCryptoJSPadding(ciphertext: string, password: string): string {
  const fromHex = (value: string) => Uint8Array.from(value.match(/../gu) ?? [], (byte) => Number.parseInt(byte, 16))
  const salt = fromHex(ciphertext.slice(0, 32))
  const iv = fromHex(ciphertext.slice(32, 64))
  const key = pbkdf2(sha1, encoder.encode(password), salt, { c: 10, dkLen: 16 })
  const padded = cbc(key, iv, { disablePadding: true }).decrypt(fromBase64(ciphertext.slice(64)))
  const padding = padded[padded.length - 1]
  if (padding < 2) throw new Error('fixture requires at least two padding bytes')
  padded[padded.length - 2] ^= 1
  const encrypted = cbc(key, iv, { disablePadding: true }).encrypt(padded)
  key.fill(0)
  padded.fill(0)
  return `${ciphertext.slice(0, 64)}${btoa(String.fromCharCode(...encrypted))}`
}

describe('legacy browser migration', () => {
  it('matches the old username hash and CryptoJS/LZ-String document format', () => {
    expect(legacyWorkspaceID('migration-integration-workspace')).toBe('778b180d')
    const workspace = parseLegacyWorkspace({
      legacy_id: '778b180d',
      documents: [{ document_id: 'abc12345', ciphertext: legacyGolden, document_hash: 'bb33cf65' }],
    })
    expect(decryptLegacyWorkspace(workspace, 'correct horse battery staple')).toEqual({ notes: [{
      id: 'abc12345', title: 'Golden note', content: '# Hello\n\nlegacy', mode: 'markdown',
      created_at: '2020-01-02T03:04:05.000Z', updated_at: '2020-02-03T04:05:06.000Z',
    }], rejectedDocumentIds: [], deletedDocumentIds: [] })
  })

  it('rejects wrong credentials without returning partial notes', () => {
    const workspace = parseLegacyWorkspace({
      legacy_id: '778b180d',
      documents: [{ document_id: 'abc12345', ciphertext: legacyGolden, document_hash: 'bb33cf65' }],
    })
    expect(() => decryptLegacyWorkspace(workspace, 'tiny')).toThrow(/incorrect|damaged/u)
  })

  it('decrypts legacy passwords shorter than eight characters', () => {
    const workspace = parseLegacyWorkspace({
      legacy_id: '778b180d',
      documents: [{ document_id: 'abc12345', ciphertext: legacyShortPasswordGolden, document_hash: 'bb33cf65' }],
    })
    expect(decryptLegacyWorkspace(workspace, 'tiny').notes[0]?.title).toBe('Golden note')
  })

  it('matches CryptoJS handling of non-uniform legacy padding', () => {
    const workspace = parseLegacyWorkspace({
      legacy_id: '778b180d',
      documents: [{ document_id: 'abc12345', ciphertext: withCryptoJSPadding(legacyGolden, 'correct horse battery staple'), document_hash: 'bb33cf65' }],
    })
    expect(decryptLegacyWorkspace(workspace, 'correct horse battery staple').notes[0]?.title).toBe('Golden note')
  })

  it('recovers a document when its server-side sync hash is missing or stale', () => {
    for (const documentHash of ['', 'deadbeef']) {
      const workspace = parseLegacyWorkspace({
        legacy_id: '778b180d',
        documents: [{ document_id: 'abc12345', ciphertext: legacyGolden, document_hash: documentHash }],
      })
      expect(decryptLegacyWorkspace(workspace, 'correct horse battery staple').notes[0]?.title).toBe('Golden note')
    }
  })

  it('keeps authenticated notes while reporting damaged legacy records', () => {
    const workspace = parseLegacyWorkspace({
      legacy_id: '778b180d',
      documents: [
        { document_id: 'abc12345', ciphertext: legacyGolden, document_hash: 'bb33cf65' },
        { document_id: 'damaged1', ciphertext: `${'0'.repeat(64)}invalid`, document_hash: 'deadbeef' },
      ],
    })
    const result = decryptLegacyWorkspace(workspace, 'correct horse battery staple')
    expect(result.notes).toHaveLength(1)
    expect(result.rejectedDocumentIds).toEqual(['damaged1'])
    expect(result.deletedDocumentIds).toEqual([])
  })

  it('omits authenticated legacy deletion markers separately from damaged records', () => {
    const workspace = parseLegacyWorkspace({
      legacy_id: '778b180d',
      documents: [
        { document_id: 'abc12345', ciphertext: legacyGolden, document_hash: 'bb33cf65' },
        { document_id: 'del12345', ciphertext: legacyDeletedGolden, document_hash: '3855f5d9' },
      ],
    })
    const result = decryptLegacyWorkspace(workspace, 'correct horse battery staple')
    expect(result.notes.map((note) => note.title)).toEqual(['Golden note'])
    expect(result.rejectedDocumentIds).toEqual([])
    expect(result.deletedDocumentIds).toEqual(['del12345'])
  })

  it('can migrate a notebook containing only authenticated deletion markers', () => {
    const workspace = parseLegacyWorkspace({
      legacy_id: '778b180d',
      documents: [{ document_id: 'del12345', ciphertext: legacyDeletedGolden, document_hash: '3855f5d9' }],
    })
    expect(decryptLegacyWorkspace(workspace, 'correct horse battery staple')).toEqual({
      notes: [], rejectedDocumentIds: [], deletedDocumentIds: ['del12345'],
    })
  })
})
