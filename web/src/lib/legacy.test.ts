import { describe, expect, it } from 'vitest'
import { decryptLegacyWorkspace, legacyWorkspaceID, parseLegacyWorkspace } from './legacy'

const legacyGolden = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fzfX6+lZfj1SrH6oQDTm/W0lUoUfyuss9ergu0hTHHSea7nzW7+XEdU6+7eeJyLYuek+ylZliq76lMbEo29ZEvCnYIhxq1pIh751Lbe3hEcMwyhSnlyIME8koPNGhl68UXIpdUJr7ykBwNKzEgarX2fpvuGbSWfYd78WGL4CFadM4iTGS71oXtM1a979lvO+BBhgbqCUsaTFNQlpy3QGKBPhQHXGGZZmbCq9K6Q/MOuY7cxRsQKXKLFlIf+Vjk1kK'
const legacyShortPasswordGolden = '000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1fBdsehS8hkZAmv6Km/qNel77CgUp3GqVh+nkt82lzkfsCLhcozQ69iqUzGRmHxFxN1+VNYMOsJTuBNrR/AAJbuA1v2lG8Sinx3DFnFZYjpRT/VEEWhN+Y2/FuSlZ3MA+BgrnfNC/OWKlyQLPnOTR5qtjo8dF4leEIBhMGhQ/eb8hVx81pconDVtOG3RWvgsZ64assh4stogsFg1h9qbtsTdxcZZHHzEsp0DaUjLf1Wbf9hpC9j5tG/Vt+7VgdwhFO'

describe('legacy browser migration', () => {
  it('matches the old username hash and CryptoJS/LZ-String document format', () => {
    expect(legacyWorkspaceID('migration-integration-workspace')).toBe('778b180d')
    const workspace = parseLegacyWorkspace({
      legacy_id: '778b180d',
      documents: [{ document_id: 'abc12345', ciphertext: legacyGolden, document_hash: 'bb33cf65' }],
    })
    expect(decryptLegacyWorkspace(workspace, 'correct horse battery staple')).toEqual([{
      id: 'abc12345', title: 'Golden note', content: '# Hello\n\nlegacy', mode: 'markdown',
      created_at: '2020-01-02T03:04:05.000Z', updated_at: '2020-02-03T04:05:06.000Z',
    }])
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
    expect(decryptLegacyWorkspace(workspace, 'tiny')[0]?.title).toBe('Golden note')
  })
})
