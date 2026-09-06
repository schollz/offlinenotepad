import { xchacha20poly1305 } from '@noble/ciphers/chacha.js'
import { ed25519 } from '@noble/curves/ed25519.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { caseFold } from 'unicode-case-folding'
import type { KdfMetadata, NoteContent, PrivateRecord, SessionKeys } from '../types'
import { concat, decoder, encoder, fromBase64, toBase64 } from './encoding'

const workspaceContext = 'offlinenotepad workspace v2\u0000'
const envelopeBegin = '-----BEGIN OFFLINE NOTEPAD DOCUMENT V2-----'
const envelopeEnd = '-----END OFFLINE NOTEPAD DOCUMENT V2-----'
let requestID = 0

export function normalizeUsername(username: string): string {
  return caseFold(username.trim().normalize('NFC'))
}

export function workspaceID(username: string): string {
  return toBase64(sha256(encoder.encode(workspaceContext + normalizeUsername(username))))
}

export function randomSalt(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(16))
}

export async function deriveKeys(password: string, metadata: KdfMetadata): Promise<SessionKeys> {
  if (typeof Worker === 'undefined') throw new Error('This browser cannot run the encryption worker.')
  const id = ++requestID
  const worker = new Worker(new URL('./kdf.worker.ts', import.meta.url), { type: 'module' })
  return await new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<SessionKeys & { id: number; error?: string }>) => {
      if (event.data.id !== id) return
      worker.terminate()
      if (event.data.error) reject(new Error(event.data.error))
      else resolve({ contentKey: event.data.contentKey, authSeed: event.data.authSeed, authPublicKey: event.data.authPublicKey })
    }
    worker.onerror = () => {
      worker.terminate()
      reject(new Error('The encryption worker stopped unexpectedly.'))
    }
    worker.postMessage({
      id,
      password,
      salt: fromBase64(metadata.kdf_salt),
      memory: metadata.kdf_memory,
      iterations: metadata.kdf_iterations,
      parallelism: metadata.kdf_parallelism,
    })
  })
}

function aad(workspace: string, document: string): Uint8Array {
  return encoder.encode(`offlinenotepad document v2\u0000${workspace}\u0000${document}`)
}

export function encryptRecord(record: PrivateRecord, workspace: string, key: Uint8Array): { ciphertext: string; hash: string } {
  const nonce = crypto.getRandomValues(new Uint8Array(24))
  const cipher = xchacha20poly1305(key, nonce, aad(workspace, record.id))
  const encrypted = cipher.encrypt(encoder.encode(JSON.stringify(record)))
  const envelope = `${envelopeBegin}\n${JSON.stringify({ v: 2, cipher: 'xchacha20-poly1305', nonce: toBase64(nonce), data: toBase64(encrypted) })}\n${envelopeEnd}`
  return { ciphertext: envelope, hash: toBase64(sha256(encoder.encode(envelope))) }
}

export function decryptRecord(ciphertext: string, workspace: string, document: string, key: Uint8Array): PrivateRecord {
  const body = ciphertext.trim().replace(envelopeBegin, '').replace(envelopeEnd, '').trim()
  const envelope = JSON.parse(body) as { v: number; cipher: string; nonce: string; data: string }
  if (envelope.v !== 2 || envelope.cipher !== 'xchacha20-poly1305') throw new Error('Unsupported encrypted note format.')
  const cipher = xchacha20poly1305(key, fromBase64(envelope.nonce), aad(workspace, document))
  const record = JSON.parse(decoder.decode(cipher.decrypt(fromBase64(envelope.data)))) as PrivateRecord
  if (record.id !== document) throw new Error('Encrypted document identifier does not match.')
  return record
}

export function encryptNote(note: NoteContent, workspace: string, key: Uint8Array): { ciphertext: string; hash: string } {
  return encryptRecord(note, workspace, key)
}

export function decryptNote(ciphertext: string, workspace: string, document: string, key: Uint8Array): NoteContent {
  const record = decryptRecord(ciphertext, workspace, document, key)
  if ('record_type' in record && record.record_type === 'folder') throw new Error('Encrypted document is not a note.')
  return record as NoteContent
}

export function signChallenge(challenge: string, seed: Uint8Array): string {
  const message = concat(encoder.encode('offlinenotepad websocket authentication v2\u0000'), fromBase64(challenge))
  return toBase64(ed25519.sign(message, seed))
}

export function clearKeys(keys: SessionKeys | null): void {
  keys?.contentKey.fill(0)
  keys?.authSeed.fill(0)
}
