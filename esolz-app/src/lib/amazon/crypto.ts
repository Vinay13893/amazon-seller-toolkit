/**
 * src/lib/amazon/crypto.ts
 *
 * Server-only. AES-256-GCM encryption for Amazon SP-API tokens.
 *
 * DO NOT import this file in any client component or in files that are
 * bundled for the browser. It uses Node.js built-in `crypto` and reads
 * a secret env var.
 *
 * Env var required:
 *   SPAPI_ENCRYPTION_KEY — 64 hex characters (= 32 bytes)
 *   Generate:  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * Storage format:
 *   <iv_hex>:<ciphertext_hex>:<authTag_hex>
 *   All three parts are lowercase hex, joined by colons.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES  = 12  // 96-bit IV — standard recommendation for GCM
const TAG_BYTES = 16  // 128-bit authentication tag

/**
 * Returns the 32-byte key buffer derived from SPAPI_ENCRYPTION_KEY.
 * Throws if the env var is missing or not exactly 64 hex chars.
 */
function getKey(): Buffer {
  const raw = process.env.SPAPI_ENCRYPTION_KEY
  if (!raw || raw.length !== 64) {
    throw new Error(
      'SPAPI_ENCRYPTION_KEY must be set to a 64-character hex string (32 bytes). ' +
      "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\""
    )
  }
  return Buffer.from(raw, 'hex')
}

/**
 * Encrypts a plaintext string with AES-256-GCM.
 * A fresh random IV is generated for every call.
 *
 * @returns Colon-delimited string: iv_hex:ciphertext_hex:authTag_hex
 */
export function encryptToken(plainText: string): string {
  const key      = getKey()
  const iv       = randomBytes(IV_BYTES)
  const cipher   = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()])
  const authTag  = cipher.getAuthTag()

  return [
    iv.toString('hex'),
    encrypted.toString('hex'),
    authTag.toString('hex'),
  ].join(':')
}

/**
 * Decrypts a token produced by encryptToken().
 * Throws on wrong key, invalid format, or authentication tag mismatch.
 *
 * @param encrypted  iv_hex:ciphertext_hex:authTag_hex
 * @returns Plaintext string
 */
export function decryptToken(encrypted: string): string {
  const parts = encrypted.split(':')
  if (parts.length !== 3) {
    throw new Error('Invalid encrypted token format — expected iv_hex:ciphertext_hex:authTag_hex')
  }

  const [ivHex, ctHex, tagHex] = parts
  const key     = getKey()
  const iv      = Buffer.from(ivHex,  'hex')
  const ct      = Buffer.from(ctHex,  'hex')
  const authTag = Buffer.from(tagHex, 'hex')

  if (iv.length      !== IV_BYTES)  throw new Error(`Invalid IV length: expected ${IV_BYTES} bytes`)
  if (authTag.length !== TAG_BYTES) throw new Error(`Invalid auth tag length: expected ${TAG_BYTES} bytes`)

  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)

  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8')
}
