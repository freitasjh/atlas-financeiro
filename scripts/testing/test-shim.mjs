// Permite que os mesmos testes nomeados rodem em `node --test` e no vitest do
// harness, sem alterar configs. Nenhum comando é executado aqui.

const nodeTest = (await import('node:test')).test
const vitestTest = process.env.VITEST === 'true' || process.env.VITEST === '1'
  ? (await import('vitest')).test
  : null

export const test = vitestTest ?? nodeTest
