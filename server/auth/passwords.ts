import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

const KEY_LENGTH = 64;
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;

function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, {
      N: COST,
      r: BLOCK_SIZE,
      p: PARALLELIZATION,
    }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await deriveKey(password, salt);
  return `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELIZATION}$${salt.toString("hex")}$${key.toString("hex")}`;
}

// An unknown email still performs the same password derivation as an existing one.
export const DUMMY_PASSWORD_HASH = `scrypt$${COST}$${BLOCK_SIZE}$${PARALLELIZATION}$${"0".repeat(32)}$${"0".repeat(KEY_LENGTH * 2)}`;

export async function verifyPassword(password: string, encodedHash: string): Promise<boolean> {
  const parts = encodedHash.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt" || parts[1] !== String(COST)
    || parts[2] !== String(BLOCK_SIZE) || parts[3] !== String(PARALLELIZATION)
    || !/^[0-9a-f]{32}$/i.test(parts[4] ?? "")
    || !/^[0-9a-f]{128}$/i.test(parts[5] ?? "")) {
    return false;
  }
  const salt = Buffer.from(parts[4]!, "hex");
  const expectedKey = Buffer.from(parts[5]!, "hex");
  const actualKey = await deriveKey(password, salt);
  return timingSafeEqual(actualKey, expectedKey);
}
