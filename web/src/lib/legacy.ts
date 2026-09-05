import { cbc } from '@noble/ciphers/aes.js'
import { sha1 } from '@noble/hashes/legacy.js'
import { pbkdf2 } from '@noble/hashes/pbkdf2.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { z } from 'zod'
import type { NoteContent } from '../types'
import { encoder, fromBase64 } from './encoding'

const legacyIDPattern = /^[a-f0-9]{8}$/u
const legacyDocumentIDPattern = /^[a-z0-9]{8}$/u

const legacyWorkspaceSchema = z.object({
  legacy_id: z.string().regex(legacyIDPattern),
  documents: z.array(z.object({
    document_id: z.string().regex(legacyDocumentIDPattern),
    ciphertext: z.string().min(65),
    document_hash: z.string().regex(legacyIDPattern),
  })).max(100_000),
})

export type StagedLegacyWorkspace = z.infer<typeof legacyWorkspaceSchema>

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fromHex(value: string): Uint8Array {
  if (value.length % 2 !== 0 || !/^[a-f0-9]+$/u.test(value)) throw new Error('Invalid legacy ciphertext.')
  const result = new Uint8Array(value.length / 2)
  for (let i = 0; i < result.length; i += 1) result[i] = Number.parseInt(value.slice(i * 2, i * 2 + 2), 16)
  return result
}

function codeUnitsToString(values: number[]): string {
  let result = ''
  for (let offset = 0; offset < values.length; offset += 8192) {
    result += String.fromCharCode(...values.slice(offset, offset + 8192))
  }
  return result
}

function decompressUTF16(values: number[]): string {
  if (values.length === 0) return ''
  const reader = { value: values[0] - 32, position: 16_384, index: 1 }
  const read = (bits: number): number => {
    let result = 0
    let power = 1
    const maximum = 1 << bits
    while (power !== maximum) {
      if (reader.position === 0 || reader.index > values.length) throw new Error('Truncated legacy note.')
      const bit = reader.value & reader.position
      reader.position >>= 1
      if (reader.position === 0) {
        reader.position = 16_384
        if (reader.index < values.length) reader.value = values[reader.index] - 32
        reader.index += 1
      }
      if (bit > 0) result |= power
      power <<= 1
    }
    return result
  }

  const prefix = read(2)
  let first: number
  if (prefix === 0) first = read(8)
  else if (prefix === 1) first = read(16)
  else if (prefix === 2) return ''
  else throw new Error('Invalid legacy note prefix.')

  const dictionary = new Map<number, number[]>([[0, []], [1, []], [2, []], [3, [first]]])
  let dictionarySize = 4
  let bitCount = 3
  let enlargeIn = 4
  let previous = [first]
  const result = [first]
  while (true) {
    let code = read(bitCount)
    if (code === 0 || code === 1) {
      const value = read(code === 0 ? 8 : 16)
      dictionary.set(dictionarySize, [value])
      code = dictionarySize
      dictionarySize += 1
      enlargeIn -= 1
    } else if (code === 2) {
      return codeUnitsToString(result)
    }
    if (enlargeIn === 0) {
      enlargeIn = 1 << bitCount
      bitCount += 1
    }
    let entry = dictionary.get(code)
    if (!entry) {
      if (code !== dictionarySize || previous.length === 0) throw new Error('Invalid legacy note dictionary.')
      entry = [...previous, previous[0]]
    }
    if (entry.length === 0) throw new Error('Invalid empty legacy note entry.')
    result.push(...entry)
    dictionary.set(dictionarySize, [...previous, entry[0]])
    dictionarySize += 1
    enlargeIn -= 1
    previous = [...entry]
    if (enlargeIn === 0) {
      enlargeIn = 1 << bitCount
      bitCount += 1
    }
  }
}

function decryptLegacyDocument(ciphertext: string, password: string, documentID: string, storedHash: string): NoteContent {
  try {
    if (ciphertext.length <= 64) throw new Error('short ciphertext')
    const salt = fromHex(ciphertext.slice(0, 32))
    const iv = fromHex(ciphertext.slice(32, 64))
    const encrypted = fromBase64(ciphertext.slice(64))
    const key = pbkdf2(sha1, encoder.encode(password), salt, { c: 10, dkLen: 16 })
    const decrypted = cbc(key, iv).decrypt(encrypted)
    key.fill(0)
    if (decrypted.length % 2 !== 0) throw new Error('invalid UTF-16')
    const compressed: number[] = []
    for (let i = 0; i < decrypted.length; i += 2) compressed.push((decrypted[i] << 8) | decrypted[i + 1])
    decrypted.fill(0)
    const parsed = JSON.parse(decompressUTF16(compressed)) as Record<string, unknown>
    if (parsed.uuid !== documentID || !legacyDocumentIDPattern.test(documentID) || typeof parsed.title !== 'string' || typeof parsed.markdown !== 'string' || typeof parsed.hash !== 'string') {
      throw new Error('invalid document')
    }
    const calculated = hex(sha256(encoder.encode(`offlinenotepad${documentID}${parsed.title}${parsed.markdown}`))).slice(0, 8)
    if (parsed.hash !== storedHash || calculated !== storedHash) throw new Error('hash mismatch')
    return {
      id: documentID,
      title: parsed.title,
      content: parsed.markdown,
      mode: parsed.title.includes('.') ? 'plaintext' : 'markdown',
      created_at: String(parsed.created ?? new Date().toISOString()),
      updated_at: String(parsed.modified ?? parsed.created ?? new Date().toISOString()),
    }
  } catch {
    throw new Error('The legacy username or password is incorrect, or its encrypted data is damaged.')
  }
}

export function legacyWorkspaceID(username: string): string {
  return hex(sha256(encoder.encode(`offlinenotepad${username}`))).slice(0, 8)
}

export function parseLegacyWorkspace(value: unknown): StagedLegacyWorkspace {
  return legacyWorkspaceSchema.parse(value)
}

export function decryptLegacyWorkspace(workspace: StagedLegacyWorkspace, password: string): NoteContent[] {
  if (password.length === 0) throw new Error('Enter your password.')
  return workspace.documents.map((document) => decryptLegacyDocument(document.ciphertext, password, document.document_id, document.document_hash))
}
