import { randomBytes } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** CSP nonce. Alphanumeric so it is safe inside quoted HTML attributes and policy text. */
export function createNonce(): string {
  const bytes = randomBytes(32);
  let nonce = '';
  for (const byte of bytes) {
    nonce += ALPHABET.charAt(byte % ALPHABET.length);
  }
  return nonce;
}
