import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const TAG_BYTES = 16;

/** A 32-byte key given as 64 hex characters. */
export function parseKey(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("secrets key must be 64 hexadecimal characters (32 bytes)");
  return Buffer.from(hex, "hex");
}

/**
 * Encrypts with a fresh random IV. `aad` is authenticated but not stored: decryption fails unless
 * the same value is supplied, so a ciphertext cannot be moved to another owner, name, or site.
 */
export function encrypt(key: Buffer, plaintext: string, aad: string): { iv: Buffer; data: Buffer } {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv, data: Buffer.concat([body, cipher.getAuthTag()]) };
}

export function decrypt(key: Buffer, iv: Buffer, data: Buffer, aad: string): string {
  if (data.length < TAG_BYTES) throw new Error("ciphertext too short");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(data.subarray(data.length - TAG_BYTES));
  return Buffer.concat([decipher.update(data.subarray(0, data.length - TAG_BYTES)), decipher.final()]).toString("utf8");
}
