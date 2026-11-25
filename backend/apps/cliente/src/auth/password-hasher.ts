import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** OWASP: scrypt N=2^17, r=8, p=1, salt único de 16 bytes, sem dependência nova. */
export const MIN_PASSWORD_LENGTH = 12;
const LN = 17;
const N = 1 << LN;
const R = 8;
const P = 1;
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
// 128 * N * r = 128 MiB por hash; default do Node (32 MiB) rejeitaria N=2^17.
const MAX_MEMORY = 256 * 1024 * 1024;

export interface ParsedPasswordHash {
  ln: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

const FORMAT = /^scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([0-9a-f]+)\$([0-9a-f]+)$/;

export function parsePasswordHash(stored: string): ParsedPasswordHash {
  const match = FORMAT.exec(stored);
  if (!match || match[4].length % 2 !== 0 || match[5].length % 2 !== 0) {
    throw new Error('hash de senha em formato inválido');
  }
  return {
    ln: Number(match[1]),
    r: Number(match[2]),
    p: Number(match[3]),
    salt: Buffer.from(match[4], 'hex'),
    key: Buffer.from(match[5], 'hex'),
  };
}

function derive(
  password: string,
  salt: Buffer,
  params: { N: number; r: number; p: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      { ...params, maxmem: MAX_MEMORY },
      (error, key) => (error ? reject(error) : resolve(key)),
    );
  });
}

function assertPasswordLength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`senha deve ter pelo menos ${MIN_PASSWORD_LENGTH} caracteres`);
  }
}

export async function hashPassword(password: string): Promise<string> {
  assertPasswordLength(password);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, { N, r: R, p: P });
  return `scrypt$ln=${LN},r=${R},p=${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  assertPasswordLength(password);
  const parsed = parsePasswordHash(stored);
  const key = await derive(password, parsed.salt, {
    N: 2 ** parsed.ln,
    r: parsed.r,
    p: parsed.p,
  });
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

export function needsRehash(stored: string): boolean {
  try {
    const parsed = parsePasswordHash(stored);
    return parsed.ln !== LN || parsed.r !== R || parsed.p !== P;
  } catch {
    return true;
  }
}
