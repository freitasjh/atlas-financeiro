import { describe, expect, it } from 'vitest';
import {
  ThrottledException,
  createLoginThrottle,
  withLoginThrottle,
} from '../src/auth/login-throttle';

describe('throttle numérico de login (AUTH-06)', () => {
  it('whenSixthRequestPerIpWithin60s_then429WithRetryAfter', () => {
    let now = 1_000_000;
    const throttle = createLoginThrottle({ now: () => now });
    for (let index = 0; index < 5; index += 1) {
      let ticket!: { release(): void };
      expect(() => {
        ticket = throttle.acquire('198.51.100.7');
      }).not.toThrow();
      ticket.release();
    }

    let denied: unknown;
    try {
      throttle.acquire('198.51.100.7');
    } catch (error) {
      denied = error;
    }
    expect(denied).toBeInstanceOf(ThrottledException);
    const throttled = denied as ThrottledException;
    expect(throttled.status).toBe(429);
    expect(throttled.retryAfterSeconds).toBeGreaterThan(0);
    expect(throttled.retryAfterSeconds).toBeLessThanOrEqual(60);

    now += 60_001;
    expect(() => throttle.acquire('198.51.100.7')).not.toThrow();
  });

  it('whenThirdConcurrentHash_then429WithRetryAfter', async () => {
    const throttle = createLoginThrottle();
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });

    const first = withLoginThrottle(throttle, '203.0.113.1', () => firstGate);
    const second = withLoginThrottle(throttle, '203.0.113.2', () => secondGate);
    const started: string[] = [];
    await expect(
      withLoginThrottle(throttle, '203.0.113.3', async () => {
        started.push('third');
      }),
    ).rejects.toMatchObject({ status: 429, retryAfterSeconds: expect.any(Number) });
    expect(started).toEqual([]);

    releaseFirst();
    releaseSecond();
    await Promise.all([first, second]);
    await expect(withLoginThrottle(throttle, '203.0.113.3', async () => undefined)).resolves.toBeUndefined();
  });

  it('whenIpWindowExpires_thenEmptyIpKeyIsRemoved', () => {
    let now = 2_000_000;
    const throttle = createLoginThrottle({ now: () => now });
    throttle.acquire('198.51.100.9').release();
    // Dois IPs saturam a concorrência: a próxima chamada é negada após a filtragem.
    throttle.acquire('198.51.100.10');
    throttle.acquire('198.51.100.11');
    expect(throttle.snapshot().trackedIps).toBe(3);

    now += 60_001;
    expect(() => throttle.acquire('198.51.100.9')).toThrow(ThrottledException);
    expect(throttle.snapshot().trackedIps).toBe(2);
  });

  it('whenHashCompletes_thenP95IsRecorded', async () => {
    let clock = 0;
    const throttle = createLoginThrottle({ now: () => (clock += 5) });
    for (let index = 0; index < 4; index += 1) {
      await withLoginThrottle(throttle, `192.0.2.${index}`, async () => undefined);
    }
    const snapshot = throttle.snapshot();
    expect(snapshot.total).toBe(4);
    expect(snapshot.p95Ms).toBeGreaterThan(0);
  });
});
