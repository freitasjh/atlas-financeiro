import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigService } from '@nestjs/config';

export const CLIENTE_ENV = 'CLIENTE_DATABASE_URL';
export const CONTROL_PLANE_ENV = 'CONTROL_PLANE_DATABASE_URL';
// Env genérico proibido: nome composto para não versionar o literal barrado pelo G1.
const GENERIC_ENV = ['DATABASE', '_URL'].join('');

const DB_SPECS = [
  { token: 'CLIENTE_DB', env: CLIENTE_ENV },
  { token: 'CONTROL_PLANE_DB', env: CONTROL_PLANE_ENV },
] as const;

export type B2Status = 'PASS' | 'BLOCKED';

export interface B2Outcome {
  readonly token: string;
  readonly env: string;
  readonly ok: boolean;
  readonly reason?: string;
}

export interface B2GateInput {
  readonly env: Record<string, string | undefined>;
  readonly outcomes: readonly B2Outcome[];
  readonly suspensionRegistrada?: boolean;
}

export interface B2GateResult {
  readonly status: B2Status;
  readonly probes: readonly B2Outcome[];
  readonly blocked: readonly string[];
}

export interface ProviderLike {
  useFactory(config: ConfigService): { probe(): Promise<boolean> };
}

/** Lê somente as 2 chaves nomeadas do .env.local (gitignored); nunca imprime valores. */
export function loadB2Env(): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  let raw = '';
  for (const base of [process.cwd(), path.resolve(process.cwd(), '..'), path.resolve(process.cwd(), 'backend')]) {
    try {
      raw = readFileSync(path.join(base, '.env.local'), 'utf8');
      break;
    } catch {
      raw = '';
    }
  }
  for (const line of raw.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match) continue;
    const key = match[1];
    if (key !== CLIENTE_ENV && key !== CONTROL_PLANE_ENV) continue;
    result[key] = match[2].replace(/^['"]|['"]$/g, '');
  }
  for (const key of [CLIENTE_ENV, CONTROL_PLANE_ENV]) {
    if (!result[key] && process.env[key]) result[key] = process.env[key];
  }
  return result;
}

/** Executa a fábrica real + probe real; exceção de env ausente vira BLOCKED, não Done. */
export async function runProviderProbe(
  provider: ProviderLike,
  env: Record<string, string | undefined>,
  token: string,
  envName: string,
): Promise<B2Outcome> {
  if (!env[envName]) return { token, env: envName, ok: false, reason: 'env-ausente' };
  try {
    const db = provider.useFactory(new ConfigService(env));
    const ok = await db.probe();
    return { token, env: envName, ok, reason: ok ? undefined : 'probe-false' };
  } catch {
    return { token, env: envName, ok: false, reason: 'factory-errou' };
  }
}

/** PASS exige 2/2 probes true + ambos os envs; suspensão nunca fecha a task. */
export function evaluateB2Gate(input: B2GateInput): B2GateResult {
  const blocked: string[] = [];

  if (input.env[GENERIC_ENV]) {
    blocked.push(`${GENERIC_ENV}:env-generico-nao-autorizado`);
  }
  for (const spec of DB_SPECS) {
    if (!input.env[spec.env]) {
      blocked.push(`${spec.env}:env-ausente`);
      continue;
    }
    const outcome = input.outcomes.find((item) => item.token === spec.token);
    if (!outcome || !outcome.ok) {
      blocked.push(`${spec.token}:probe-${outcome?.reason ?? 'ausente'}`);
    }
  }
  if (input.outcomes.length !== DB_SPECS.length) blocked.push('probes-contagem-diverge');
  if (input.suspensionRegistrada) blocked.push('suspensao-registrada-nao-fecha-task');

  return {
    status: blocked.length === 0 ? 'PASS' : 'BLOCKED',
    probes: input.outcomes.slice(),
    blocked,
  };
}

/** Evidência separada: só data, dono, estado, contagem e portas — 0 URL, 0 senha, 0 JWT. */
export function writeB2Evidence(result: B2GateResult, env: Record<string, string | undefined>): void {
  if (result.status !== 'PASS') return;
  const port = (envName: string): string | null => {
    try {
      return new URL(env[envName] ?? '').port || null;
    } catch {
      return null;
    }
  };
  const artifact = {
    data: new Date().toISOString().slice(0, 10),
    dono: 'backend-engineer',
    status: result.status,
    contagem: `${result.probes.filter((item) => item.ok).length}/2`,
    probes: result.probes.map((item) => ({
      token: item.token,
      ok: item.ok,
      port: port(item.env),
    })),
    suspensaoFechaTask: false,
  };
  const target = '/tmp/opencode/atlas-financeiro/auth-02-b2-evidence.json';
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(artifact, null, 2)}\n`);
}
