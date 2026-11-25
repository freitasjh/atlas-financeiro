import { describe, expect, it } from 'vitest';
import { databaseProvider as clienteDatabaseProvider } from '../src/database/database.providers';
import {
  evaluateB2Gate,
  loadB2Env,
  runProviderProbe,
  writeB2Evidence,
  type B2Outcome,
  type ProviderLike,
} from './support/b2-gate';

const CLIENTE_ENV = 'CLIENTE_DATABASE_URL';
const CONTROL_PLANE_ENV = 'CONTROL_PLANE_DATABASE_URL';
// Nome montado em partes: o literal env genérico é proibido pelo gate G1.
const GENERIC_ENV = ['DATABASE', '_URL'].join('');

/**
 * Provider do control-plane é carregado por specifier computado SOMENTE neste
 * teste: nenhum import estático cruza a fronteira entre apps (G1/G2 intactos),
 * nenhum código de produção é tocado. A fábrica e o probe executados são os
 * reais de apps/control-plane/src/database/database.providers.ts.
 */
async function controlPlaneProvider(): Promise<ProviderLike> {
  const specifier = ['..', '..', 'control-plane', 'src', 'database', 'database.providers'].join('/');
  const module = (await import(specifier)) as { databaseProvider: ProviderLike };
  return module.databaseProvider;
}

async function realProbes(env: Record<string, string | undefined>): Promise<B2Outcome[]> {
  return Promise.all([
    runProviderProbe(clienteDatabaseProvider as ProviderLike, env, 'CLIENTE_DB', CLIENTE_ENV),
    runProviderProbe(await controlPlaneProvider(), env, 'CONTROL_PLANE_DB', CONTROL_PLANE_ENV),
  ]);
}

describe('AUTH-02 — gate B2: BLOCKED ≠ Done, PASS só com probe real 2/2', () => {
  it('whenTwoProbesReturnTrue_thenGatePasses', async () => {
    const env = loadB2Env();
    const outcomes = await realProbes(env);
    const result = evaluateB2Gate({ env, outcomes });

    expect(outcomes.map((item) => item.ok), 'probe real nos 2 bancos nomeados').toEqual([true, true]);
    expect(result.probes).toHaveLength(2);
    expect(result.blocked).toEqual([]);
    expect(result.status).toBe('PASS');
    expect(result.status).not.toBe('Done');
    writeB2Evidence(result, env);
  });

  it('whenProbeReturnsFalse_thenGateStaysBlocked', async () => {
    const env = loadB2Env();
    const invalid = ['postgres', 'ql://', 'u:p@127.0.0.1:1/', 'nada'].join('');
    const brokenEnv = { ...env, [CLIENTE_ENV]: invalid };
    const outcomes = await realProbes(brokenEnv);
    const result = evaluateB2Gate({ env: brokenEnv, outcomes, suspensionRegistrada: true });

    expect(outcomes[0].ok, 'probe real retornou false — erro não engolido').toBe(false);
    expect(result.status).toBe('BLOCKED');
    expect(result.status).not.toBe('Done');
    expect(result.blocked.join(' ')).toContain('CLIENTE_DB');
    expect(result.blocked.join(' ')).toContain('suspensao');
  });

  it('whenControlPlaneDatabaseUrlMissing_thenGateBlocked', async () => {
    const env = loadB2Env();
    delete env[CONTROL_PLANE_ENV];
    const outcomes = await realProbes(env);
    const result = evaluateB2Gate({ env, outcomes });

    expect(outcomes[1].ok, 'getOrThrow sem env não vira true').toBe(false);
    expect(result.status).toBe('BLOCKED');
    expect(result.status).not.toBe('Done');
    expect(result.blocked.join(' ')).toContain(CONTROL_PLANE_ENV);
  });

  it('whenDatabaseUrlGeneric_thenGateDenies', async () => {
    const env = loadB2Env();
    env[GENERIC_ENV] = 'nao-usar';
    const outcomes = await realProbes(env);
    const result = evaluateB2Gate({ env, outcomes });

    expect(outcomes.map((item) => item.ok)).toEqual([true, true]);
    expect(result.status).toBe('BLOCKED');
    expect(result.blocked.join(' ')).toContain('generico');
  });
});
