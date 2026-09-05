import { ed25519 } from '@noble/curves/ed25519.js'
import { argon2id } from '@noble/hashes/argon2.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import type { SessionKeys } from '../types'
import { encoder } from './encoding'

export function deriveKeyMaterial(password: string, salt: Uint8Array, memory: number, iterations: number, parallelism: number): SessionKeys {
  const master = argon2id(encoder.encode(password.normalize('NFC')), salt, { m: memory, t: iterations, p: parallelism, dkLen: 32 })
  const contentKey = hkdf(sha256, master, undefined, encoder.encode('offlinenotepad content key v2'), 32)
  const authSeed = hkdf(sha256, master, undefined, encoder.encode('offlinenotepad auth seed v2'), 32)
  const authPublicKey = ed25519.getPublicKey(authSeed)
  master.fill(0)
  return { contentKey, authSeed, authPublicKey }
}
