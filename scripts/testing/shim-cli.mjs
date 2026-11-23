// Shim de PATH SOMENTE no harness de teste (RF-11 / IN-1). Intercepta e recusa;
// nunca executa a CLI de verdade. Nenhuma referência em scripts de produção.

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadVerbs, matchesVerb } from '../guard-mutating-verbs.mjs'

export function refuse(command, options = {}) {
  const verbs = options.verbs ?? loadVerbs().verbs
  return matchesVerb(command, verbs) !== null
}

export function runShimCli(argv = process.argv.slice(2)) {
  const command = argv.join(' ')
  if (refuse(command)) {
    process.stdout.write('RECUSADO pattern=IN-4 redacted=true (nenhuma execucao real)\n')
    return 1
  }
  process.stdout.write('OK pattern=none redacted=true (nenhuma execucao real)\n')
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) process.exitCode = runShimCli()
