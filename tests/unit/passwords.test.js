import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../../src/security/passwords.js';

describe('password utilities', () => {
  it('hashes a valid password and verifies it without storing plaintext', async () => {
    const password = 'a-long-unique-test-password';
    const hash = await hashPassword(password);
    expect(hash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(hash).not.toContain(password);
    await expect(verifyPassword(password, hash)).resolves.toBe(true);
    await expect(verifyPassword('a-different-password', hash)).resolves.toBe(false);
  });

  it('rejects weak passwords during account creation', async () => {
    await expect(hashPassword('short')).rejects.toThrow('12 and 128 characters');
  });

  it('rejects malformed hashes safely', async () => {
    await expect(verifyPassword('any password', 'not-a-hash')).resolves.toBe(false);
  });
});
