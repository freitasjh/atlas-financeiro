import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  hashPassword,
  needsRehash,
  parsePasswordHash,
  verifyPassword,
} from '../src/auth/password-hasher';

describe('hash de senha scrypt nativo (AUTH-06)', () => {
  it('whenPasswordHashed_thenFormatCarriesOwaspParameters', async () => {
    const password = 'senha-do-teste';
    const first = await hashPassword(password);
    const second = await hashPassword(password);

    expect(first).toMatch(/^scrypt\$ln=17,r=8,p=1\$[0-9a-f]{32}\$[0-9a-f]{128}$/);
    const parsed = parsePasswordHash(first);
    expect(parsed.ln).toBe(17);
    expect(parsed.r).toBe(8);
    expect(parsed.p).toBe(1);
    expect(parsed.salt.toString('hex')).not.toBe(parsePasswordHash(second).salt.toString('hex'));
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword(`${password}x`, first)).toBe(false);
  });

  it('whenPasswordTooShort_thenRejectedBeforeScrypt', async () => {
    expect(MIN_PASSWORD_LENGTH).toBe(12);
    await expect(hashPassword('curta')).rejects.toThrow(/12/);
    await expect(verifyPassword('curta', 'scrypt$ln=17,r=8,p=1$aa$bb')).rejects.toThrow(/12/);
  });

  it('whenStoredParametersAreOutdated_thenRehashRequired', () => {
    const old = 'scrypt$ln=14,r=8,p=1$' + 'ab'.repeat(16) + '$' + 'cd'.repeat(64);
    expect(needsRehash(old)).toBe(true);
    expect(needsRehash('scrypt$ln=17,r=8,p=1$' + 'ab'.repeat(16) + '$' + 'cd'.repeat(64))).toBe(false);
  });
});
