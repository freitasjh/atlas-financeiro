/**
 * Throttle numérico do login (AUTH-06): 5 requisições por IP/60 s e no máximo
 * 2 hashes scrypt concorrentes por processo. Contador em memória do processo —
 * isto é limite de requisição, não store de sessão.
 */
export const LOGIN_THROTTLE = 'LOGIN_THROTTLE';

export interface ThrottleOptions {
  now?: () => number;
  windowMs?: number;
  maxPerIp?: number;
  maxConcurrent?: number;
}

export interface ThrottleTicket {
  release(): void;
}

export interface ThrottleSnapshot {
  total: number;
  rejected: number;
  p95Ms: number;
  trackedIps: number;
}

export interface LoginThrottle {
  acquire(ip: string): ThrottleTicket;
  snapshot(): ThrottleSnapshot;
}

export class ThrottledException extends Error {
  readonly status = 429 as const;
  constructor(readonly retryAfterSeconds: number) {
    super('login limitado');
    this.name = 'ThrottledException';
  }
}

const DURATION_SAMPLE_LIMIT = 1000;

export function createLoginThrottle(options: ThrottleOptions = {}): LoginThrottle {
  const now = options.now ?? Date.now;
  const windowMs = options.windowMs ?? 60_000;
  const maxPerIp = options.maxPerIp ?? 5;
  const maxConcurrent = options.maxConcurrent ?? 2;
  const requests = new Map<string, number[]>();
  const durations: number[] = [];
  let active = 0;
  let rejected = 0;

  function retryAfterFor(ip: string): number {
    const oldest = requests.get(ip)?.[0];
    if (oldest === undefined) return 1;
    return Math.max(1, Math.ceil((oldest + windowMs - now()) / 1000));
  }

  return {
    acquire(ip: string): ThrottleTicket {
      const current = now();
      const recent = (requests.get(ip) ?? []).filter((time) => time > current - windowMs);
      if (recent.length === 0) requests.delete(ip);
      else requests.set(ip, recent);
      if (recent.length >= maxPerIp || active >= maxConcurrent) {
        rejected += 1;
        throw new ThrottledException(recent.length >= maxPerIp ? retryAfterFor(ip) : 1);
      }
      recent.push(current);
      requests.set(ip, recent);
      active += 1;
      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          active -= 1;
          durations.push(Math.max(0, now() - current));
          if (durations.length > DURATION_SAMPLE_LIMIT) durations.shift();
        },
      };
    },
    snapshot(): ThrottleSnapshot {
      const ordered = durations.slice().sort((a, b) => a - b);
      let total = 0;
      for (const times of requests.values()) total += times.length;
      const p95Ms = ordered.length === 0
        ? 0
        : ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)];
      return { total, rejected, p95Ms, trackedIps: requests.size };
    },
  };
}

export async function withLoginThrottle<T>(
  throttle: LoginThrottle,
  ip: string,
  work: () => Promise<T>,
): Promise<T> {
  const ticket = throttle.acquire(ip);
  try {
    return await work();
  } finally {
    ticket.release();
  }
}
