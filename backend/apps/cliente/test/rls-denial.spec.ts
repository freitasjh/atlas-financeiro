import { describe, it } from 'vitest';

// BLOQUEANTE-INFRA (B2): dois Postgres provisionados por humano.
// gate estático prova configuração nomeada, NUNCA isolamento RLS verificado.
const rlsDatabaseAvailable = process.env.RLS_DB_AVAILABLE === 'true';

describe.skipIf(!rlsDatabaseAvailable)('negação RLS em CLIENTE_DB (B2)', () => {
  it('whenClienteAppRoleReadsControlPlaneSchema_thenDenied', async () => {
    throw new Error('IT pendente de provisionamento humano dos dois Postgres');
  });

  it('whenControlPlaneRoleReadsClienteSchema_thenDenied', async () => {
    throw new Error('IT pendente de provisionamento humano dos dois Postgres');
  });
});
