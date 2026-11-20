// Bridge mínimo `Deno.test` → `node:test` para rodar os testes das Edge
// Functions em ambiente sem o binário `deno` (CI/dev sem Deno instalado).
// Uso: `npm run test:edge` (ver package.json). Não substitui `deno test`
// em runtime Deno real — apenas executa o mesmo arquivo sob Node.
import test from 'node:test'

globalThis.Deno = {
  test: (name, fn) => test(name, fn),
  env: { get: () => undefined },
}
