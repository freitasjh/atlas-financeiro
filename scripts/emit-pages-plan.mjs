// IN-6 — plano Pages emitido localmente. `intendedCommands`/`notes` são DADOS
// não executáveis (emenda 🟡-1): nenhum spawn de wrangler, nenhuma chamada
// externa, nenhum valor real. `pages deploy` não tem `--dry-run` na doc de
// https://developers.cloudflare.com/workers/wrangler/commands/pages/ (2026-11-22).

export const PAGES_PLAN = Object.freeze({
  schema: 'pages-plan/v1',
  mode: 'validation',
  project: '<PLACEHOLDER_PAGES_PROJECT>',
  branch: '<PLACEHOLDER_BRANCH>',
  directory: 'dist',
  intendedCommands: Object.freeze([
    'npm run build',
    'npx wrangler pages deploy dist --project-name <PLACEHOLDER_PAGES_PROJECT> --branch <PLACEHOLDER_BRANCH>',
  ]),
  mutationExecuted: false,
  notes: Object.freeze(['wrangler pages deploy nao tem --dry-run na doc consultada em 2026-11-22']),
})

export function buildPagesPlan() {
  return {
    schema: PAGES_PLAN.schema,
    mode: PAGES_PLAN.mode,
    project: PAGES_PLAN.project,
    branch: PAGES_PLAN.branch,
    directory: PAGES_PLAN.directory,
    intendedCommands: [...PAGES_PLAN.intendedCommands],
    mutationExecuted: PAGES_PLAN.mutationExecuted,
    notes: [...PAGES_PLAN.notes],
  }
}

export function isPagesPlanValid(plan) {
  if (!plan || typeof plan !== 'object') return false
  try {
    return JSON.stringify(plan) === JSON.stringify(buildPagesPlan())
  } catch {
    return false
  }
}

const invokedDirectly = process.argv[1] !== undefined
  && process.argv[1].endsWith('emit-pages-plan.mjs')
if (invokedDirectly) process.stdout.write(`${JSON.stringify(buildPagesPlan())}\n`)
