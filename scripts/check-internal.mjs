#!/usr/bin/env node
/**
 * Gate estático do control plane — numeração da SPEC §8.2 (G-01..G-10).
 *
 * Falha fechado com exit 1 quando qualquer checagem encontra uma violação. O
 * escopo é `src/**` (e `src/internal/**` onde indicado); testes (`*.spec.*`,
 * `__tests__/`) são ignorados nas checagens de código porque afirmam a ausência
 * dos padrões.
 *
 * | # | Checagem |
 * |---|---|
 * | G-01 | zero PostgREST na árvore: `src/internal/**` sem `.from(` |
 * | G-02 | `.rpc(` e `@/lib/supabase` só em `src/internal/data/**` |
 * | G-03 | árvore lazy: `src/router.tsx` importa `internal-tree` via `lazy()`; `src/main.tsx` não importa `src/internal` |
 * | G-04 | veredito não persiste: `src/internal/guard/**` sem storage |
 * | G-05 | operador não tem tenant: `src/internal/**` sem `switch_tenant|list_my_tenants|user_active_tenants` |
 * | G-06 | mock fora do `src/`: sem `internal-admin/backoffice` nem `mockViews.(admin|backoffice)` |
 * | G-07 | telemetria sem número inventado: `src/internal/**` sem `app/dashboard/data.json` |
 * | G-08 | onboarding único: `pendingPasswordSetup` só na allowlist de REQ-24 |
 * | G-09 | sem `service_role` no cliente |
 * | G-10 | artefato pós-build (`--dist`): sem mock no `dist/assets`, chunk interno presente |
 *
 * Uso:
 *   node scripts/check-internal.mjs             # estado do projeto
 *   node scripts/check-internal.mjs --root DIR  # fixture/CI
 *   node scripts/check-internal.mjs --dist      # exige o chunk interno no dist
 *   node scripts/check-internal.mjs --self-test # prova negativa (1 fixture por gate)
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PROJECT_ROOT = (() => {
  try {
    return resolve(fileURLToPath(new URL('..', import.meta.url)))
  } catch {
    return process.cwd()
  }
})()

const SOURCE_DIR = 'src'
const INTERNAL_DIR = 'src/internal'
const INTERNAL_DATA_DIR = 'src/internal/data'
const INTERNAL_GUARD_DIR = 'src/internal/guard'
const ROUTER_FILE = 'src/router.tsx'
const MAIN_FILE = 'src/main.tsx'
const INTERNAL_CHUNK = /^internal-tree-[^/]+\.js$/

/** Allowlist de `pendingPasswordSetup` (REQ-24) — fora dela, G-08 falha. */
const ONBOARDING_ALLOWLIST = new Set([
  'src/lib/pending-password-setup.ts',
  'src/routes/guards.tsx',
  'src/pages/SetPasswordPage.tsx',
  'src/internal/guard/resolve-onboarding.ts',
])

const POSTGREST = /\.from\s*\(/
const RAW_RPC = /\.rpc\s*\(/
const SUPABASE_IMPORT = /@\/lib\/supabase(?=["'])/
const STORAGE = /localStorage|sessionStorage|indexedDB|document\.cookie/
const TENANT_API = /switch_tenant|list_my_tenants|user_active_tenants/
const MOCK_REFERENCE =
  /components\/shadcn\/(?:internal-admin|backoffice)\b|mockViews\.(?:admin|backoffice)\b/
const INVENTED_DATA = /app\/dashboard\/data\.json/
const ONBOARDING = /pendingPasswordSetup/
const SERVICE_ROLE = /service_role/i
const LAZY_INTERNAL_TREE = /lazy\(\(\)\s*=>\s*import\("@\/internal\/internal-tree"\)/
const MAIN_INTERNAL_IMPORT = /(?:@\/internal|\.\/internal|src\/internal)\//
const COMMERCIAL_TAXONOMY = /(^|[^A-Za-z0-9_-])(starter|pro|enterprise)([^A-Za-z0-9_-]|$)/i
const DIST_MOCK = /mockViews\.(?:admin|backoffice)\b/

const isTestFile = (rel) =>
  /(^|\/)(__tests__|__mocks__)\//.test(rel) || /\.(spec|test)\.[cm]?[jt]sx?$/.test(rel)

const isCommentLine = (line) => {
  const trimmed = line.trimStart()
  return (
    trimmed.startsWith('//') ||
    trimmed.startsWith('/*') ||
    trimmed.startsWith('*') ||
    trimmed.startsWith('*/')
  )
}

/** Lista recursiva de arquivos, com paths relativos em `/`. */
function walk(root, relDir) {
  const absolute = join(root, relDir)
  if (!existsSync(absolute)) return []
  const found = []
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const rel = `${relDir}/${entry.name}`
    if (entry.isDirectory()) {
      found.push(...walk(root, rel))
    } else if (entry.isFile()) {
      found.push(rel)
    }
  }
  return found.sort()
}

function readLines(root, rel) {
  return readFileSync(join(root, rel), 'utf8').split(/\r?\n/)
}

function scanLines(root, files, pattern, gate, message, options = {}) {
  const violations = []
  for (const rel of files) {
    if (options.skip && options.skip(rel)) continue
    const lines = readLines(root, rel)
    lines.forEach((line, index) => {
      if (options.skipComment && isCommentLine(line)) return
      if (pattern.test(line)) {
        violations.push({ gate, path: rel, line: index + 1, message })
      }
    })
  }
  return violations
}

/**
 * G-03 — a árvore só entra no bundle por `lazy()` no router e nunca no grafo
 * estático de `main.tsx`.
 */
function checkLazyTree(root) {
  const violations = []

  const routerAbsolute = join(root, ROUTER_FILE)
  if (!existsSync(routerAbsolute)) {
    violations.push({
      gate: 'G-03',
      path: ROUTER_FILE,
      line: 0,
      message: 'router ausente — sem prova de que a árvore interna é lazy',
    })
  } else if (!LAZY_INTERNAL_TREE.test(readFileSync(routerAbsolute, 'utf8'))) {
    violations.push({
      gate: 'G-03',
      path: ROUTER_FILE,
      line: 0,
      message: 'internal-tree não é importado via lazy() no router',
    })
  }

  const mainAbsolute = join(root, MAIN_FILE)
  if (!existsSync(mainAbsolute)) {
    violations.push({
      gate: 'G-03',
      path: MAIN_FILE,
      line: 0,
      message: 'main ausente — sem prova de que src/internal está fora do grafo estático',
    })
  } else {
    readFileSync(mainAbsolute, 'utf8')
      .split(/\r?\n/)
      .forEach((line, index) => {
        if (isCommentLine(line)) return
        if (MAIN_INTERNAL_IMPORT.test(line)) {
          violations.push({
            gate: 'G-03',
            path: MAIN_FILE,
            line: index + 1,
            message: 'main.tsx não pode importar src/internal (grafo estático)',
          })
        }
      })
  }

  return violations
}

/** G-10 — artefato pós-build. Só exige o chunk quando `requireDist`. */
function checkDist(root, requireDist) {
  const assetsDir = join(root, 'dist', 'assets')
  if (!existsSync(assetsDir)) {
    return requireDist
      ? [{ gate: 'G-10', path: 'dist/assets', line: 0, message: 'artefato ausente — rode o build' }]
      : []
  }

  const assets = readdirSync(assetsDir).filter((name) => name.endsWith('.js')).sort()
  const violations = []
  for (const name of assets) {
    const text = readFileSync(join(assetsDir, name), 'utf8')
    if (DIST_MOCK.test(text)) {
      violations.push({
        gate: 'G-10',
        path: `dist/assets/${name}`,
        line: 0,
        message: 'referência ao mock admin/backoffice no artefato',
      })
    }
  }

  const internalChunks = assets.filter((name) => INTERNAL_CHUNK.test(name))
  if (internalChunks.length === 0) {
    if (requireDist) {
      violations.push({
        gate: 'G-10',
        path: 'dist/assets',
        line: 0,
        message: 'chunk internal-tree-*.js ausente — o control plane não é lazy no artefato',
      })
    }
    return violations
  }

  for (const name of internalChunks) {
    const text = readFileSync(join(assetsDir, name), 'utf8')
    if (COMMERCIAL_TAXONOMY.test(text)) {
      violations.push({
        gate: 'G-10',
        path: `dist/assets/${name}`,
        line: 0,
        message: 'taxonomia comercial (starter/pro/enterprise) no chunk interno',
      })
    }
  }
  return violations
}

/**
 * Executa G-01..G-10 numa raiz de projeto. Devolve `{ exitCode, violations }`
 * sem lançar — é o contrato usado pelos testes e pelo `--self-test`.
 */
export function runChecks({ root = PROJECT_ROOT, requireDist = false } = {}) {
  const srcFiles = walk(root, SOURCE_DIR)
  const srcCode = srcFiles.filter((rel) => !isTestFile(rel))
  const internalFiles = srcFiles.filter((rel) => rel.startsWith(`${INTERNAL_DIR}/`))
  const internalCode = internalFiles.filter((rel) => !isTestFile(rel))
  const internalOutsideData = internalCode.filter(
    (rel) => !rel.startsWith(`${INTERNAL_DATA_DIR}/`),
  )
  const guardFiles = internalFiles.filter((rel) => rel.startsWith(`${INTERNAL_GUARD_DIR}/`))

  const violations = [
    // G-01 — zero PostgREST na árvore interna.
    ...scanLines(
      root,
      internalCode,
      POSTGREST,
      'G-01',
      'PostgREST (.from) proibido em src/internal/**',
    ),
    // G-02 — `.rpc(` e `@/lib/supabase` só em src/internal/data/**.
    ...scanLines(
      root,
      internalOutsideData,
      RAW_RPC,
      'G-02',
      '.rpc( só é permitido em src/internal/data/**',
    ),
    ...scanLines(
      root,
      internalOutsideData,
      SUPABASE_IMPORT,
      'G-02',
      '@/lib/supabase só é importado em src/internal/data/**',
    ),
    // G-03 — árvore lazy (router + main).
    ...checkLazyTree(root),
    // G-04 — veredito do guard não persiste.
    ...scanLines(
      root,
      guardFiles,
      STORAGE,
      'G-04',
      'persistência de sessão/veredito proibida em src/internal/guard/**',
    ),
    // G-05 — operador não tem tenant.
    ...scanLines(
      root,
      internalCode,
      TENANT_API,
      'G-05',
      'API de tenant ativo (switch_tenant/list_my_tenants/user_active_tenants) proibida em src/internal/**',
    ),
    // G-06 — mock fora do src/.
    ...scanLines(
      root,
      srcCode,
      MOCK_REFERENCE,
      'G-06',
      'referência ao mock internal-admin/backoffice proibida em src/**',
    ),
    // G-07 — telemetria sem número inventado.
    ...scanLines(
      root,
      internalCode,
      INVENTED_DATA,
      'G-07',
      'app/dashboard/data.json não é fonte da árvore interna',
    ),
    // G-08 — onboarding único.
    ...scanLines(
      root,
      srcCode,
      ONBOARDING,
      'G-08',
      'pendingPasswordSetup só é permitido na allowlist de REQ-24',
      { skip: (rel) => ONBOARDING_ALLOWLIST.has(rel) },
    ),
    // G-09 — service_role nunca no cliente.
    ...scanLines(
      root,
      srcCode,
      SERVICE_ROLE,
      'G-09',
      'service_role/SERVICE_ROLE proibido no bundle do cliente',
      { skipComment: true },
    ),
    // G-10 — artefato pós-build.
    ...checkDist(root, requireDist),
  ]

  return {
    exitCode: violations.length === 0 ? 0 : 1,
    violations,
    checked: {
      src: srcFiles.length,
      internal: internalFiles.length,
    },
  }
}

function formatReport(report) {
  if (report.exitCode === 0) {
    return `check-internal: OK (G-01..G-10; ${report.checked.src} arquivos em src/)`
  }
  const lines = [`check-internal: FALHOU — ${report.violations.length} violação(ões)`]
  for (const violation of report.violations) {
    const location = violation.line > 0 ? `${violation.path}:${violation.line}` : violation.path
    lines.push(`  ${location} [${violation.gate}] ${violation.message}`)
  }
  return lines.join('\n')
}

/**
 * Baseline mínimo de G-03 (router lazy + main sem internal) para que cada
 * fixture negativa viole **apenas** o gate que está provando.
 */
const SELF_TEST_BASELINE = {
  [ROUTER_FILE]: [
    'import { lazy } from "react"',
    'const InternalTree = lazy(() =>',
    '  import("@/internal/internal-tree").then((m) => ({ default: m.InternalTree })),',
    ')',
    'export { InternalTree }',
    '',
  ].join('\n'),
  [MAIN_FILE]: "import './router'\n",
}

/** Uma fixture negativa por gate (10 casos) — a prova do `--self-test`. */
const SELF_TEST_FIXTURES = [
  {
    gate: 'G-01',
    files: {
      'src/internal/pages/evil.ts': "export const tenants = supabase.from('tenants').select('*')\n",
    },
  },
  {
    gate: 'G-02',
    files: {
      'src/internal/pages/evil.ts': 'export const rows = supabase.rpc("admin_count_tenants")\n',
    },
  },
  {
    gate: 'G-03',
    files: { [MAIN_FILE]: 'import "@/internal/internal-tree"\n' },
  },
  {
    gate: 'G-04',
    files: {
      'src/internal/guard/evil.ts': 'export const verdict = localStorage.getItem("verdict")\n',
    },
  },
  {
    gate: 'G-05',
    files: {
      'src/internal/pages/evil.ts': 'export const fn = "switch_tenant"\n',
    },
  },
  {
    gate: 'G-06',
    files: {
      'src/pages/evil.ts': 'export const view = "mockViews.admin"\n',
    },
  },
  {
    gate: 'G-07',
    files: {
      'src/internal/pages/evil.ts': 'export const src = "app/dashboard/data.json"\n',
    },
  },
  {
    gate: 'G-08',
    files: {
      'src/internal/pages/evil.ts': 'export const flag = pendingPasswordSetup\n',
    },
  },
  {
    gate: 'G-09',
    files: {
      'src/lib/evil.ts': 'export const key = "service_role"\n',
    },
  },
  {
    gate: 'G-10',
    requireDist: true,
    files: {
      'dist/assets/internal-tree-evil.js': 'export const view = "mockViews.admin"\n',
    },
  },
]

function writeFixture(files) {
  const root = mkdtempSync(join(tmpdir(), 'check-internal-self-'))
  for (const [path, content] of Object.entries({ ...SELF_TEST_BASELINE, ...files })) {
    const absolute = join(root, path)
    mkdirSync(join(absolute, '..'), { recursive: true })
    writeFileSync(absolute, content)
  }
  return root
}

/**
 * Prova negativa do gate: para cada G-01..G-10, uma fixture que viola **só**
 * aquele gate precisa ser reprovada.
 */
export function selfTest() {
  let failures = 0
  for (const fixture of SELF_TEST_FIXTURES) {
    const root = writeFixture(fixture.files)
    try {
      const report = runChecks({ root, requireDist: fixture.requireDist ?? false })
      const hit = report.violations.some((violation) => violation.gate === fixture.gate)
      if (report.exitCode !== 1 || !hit) {
        failures += 1
        process.stderr.write(
          `check-internal: self-test FALHOU — ${fixture.gate} não reprovou a fixture negativa\n`,
        )
      } else {
        process.stdout.write(`check-internal: self-test OK — ${fixture.gate} reprovado\n`)
      }
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  if (failures > 0) {
    process.stderr.write(`check-internal: self-test FALHOU (${failures}/${SELF_TEST_FIXTURES.length})\n`)
    return 1
  }
  process.stdout.write(
    `check-internal: self-test OK (${SELF_TEST_FIXTURES.length}/${SELF_TEST_FIXTURES.length} gates reprovados)\n`,
  )
  return 0
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--self-test')) return selfTest()

  const rootFlag = argv.indexOf('--root')
  const root = rootFlag >= 0 ? resolve(argv[rootFlag + 1] ?? '.') : PROJECT_ROOT
  const report = runChecks({ root, requireDist: argv.includes('--dist') })
  const text = formatReport(report)
  const stream = report.exitCode === 0 ? process.stdout : process.stderr
  stream.write(`${text}\n`)
  return report.exitCode
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exit(main())
}

export { PROJECT_ROOT, SOURCE_DIR, INTERNAL_DIR, ONBOARDING_ALLOWLIST }
