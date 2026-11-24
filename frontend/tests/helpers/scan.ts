import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TESTS_ROOT = dirname(fileURLToPath(import.meta.url))
export const FRONTEND_ROOT = resolve(TESTS_ROOT, '..', '..')
export const REPO_ROOT = resolve(FRONTEND_ROOT, '..')
export const frontendPath = (...parts: string[]) => join(FRONTEND_ROOT, ...parts)

// SPEC vigente = ADR-002 (big-bang). A ADR-001 deixou de ser prova de isolamento.
export const SPEC_PATH = join(
  REPO_ROOT,
  '.spec/prd/frontend-migracao/ADRs/ADR-002-bigbang-move/SPEC.md',
)
export const TASKS_PATH = join(
  REPO_ROOT,
  '.spec/prd/frontend-migracao/ADRs/ADR-002-bigbang-move/TASKS.md',
)

// Assinaturas montadas por fragmentos: o helper nunca contém o literal que procura.
const remote = 'supa' + 'base'
const remoteEnv = 'VITE' + '_' + 'SUPA' + 'BASE' + '_'
const payA = 'asa' + 'as'
const payB = 'check' + 'out'
const payC = 'p' + 'sp'
const payD = 'paga' + 'mento'
const persistA = 'local' + 'Storage'
const persistB = 'session' + 'Storage'
const persistC = 'document' + '.cookie'
const adapter = 'Express' + 'Adapter'
const proxy = 'server' + '.proxy'
const browserRouter = 'createBrowser' + 'Router'
const badContext = 'contexto ' + 'inválido'
const swagger = '@nestjs/' + 'swagger'

// FRONT (RF-07/08): `remote`/`remoteEnv` saem de FORBIDDEN — viram DÍVIDA
// localizada (debtHits). `keyMaterial` vira varredura de padrão real de
// credencial (secretPatternHits), não substring "SECRET" (que aparece em
// rótulos de MFA e fixtures herdadas sem ser segredo).
export const FORBIDDEN: Readonly<Record<string, string>> = Object.freeze({
  payA,
  payB,
  payC,
  payD,
  persistA,
  persistB,
  persistC,
  adapter,
  proxy,
  browserRouter,
  badContext,
  swagger,
})

export const DEBT_MARKER = 'DEBT' + '-' + 'SUPABASE'
export const DEBT_DOC = 'docs/debt-supabase.md'
export const DEBT_MANIFEST_PATH = 'docs/debt-files.json'

export interface DebtManifest {
  version: number
  generated: string
  marker: string
  files: string[]
}

/** Fonte única do inventário: arquivos que HOJE contêm o acoplamento herdado. */
export function debtManifest(): DebtManifest {
  const raw = JSON.parse(readFileSync(frontendPath(DEBT_MANIFEST_PATH), 'utf8')) as DebtManifest
  if (raw?.version !== 1 || !Array.isArray(raw.files) || raw.files.length === 0) {
    throw new Error('debt-files.json inválido: inventário vazio ou versão desconhecida')
  }
  return raw
}

const DEBT_FILES: ReadonlySet<string> = new Set(debtManifest().files)
const isDebtPinned = (rel: string): boolean => DEBT_FILES.has(rel)

/** Padrões de material de credencial REAL — nunca rótulo/fixture de UI. */
const sbPrefix = 'sb' + '_secret_'
const jwtName = 'JWT' + '_SECRET'
const dbName = 'DATA' + 'BASE_URL'
const roleName = 'SUPABASE_SERVICE' + '_ROLE_KEY'
const roleShort = 'SERVICE' + '_ROLE_KEY'
const SECRET_PATTERNS: readonly RegExp[] = [
  new RegExp(`${sbPrefix}[A-Za-z0-9_-]{8,}`, 'i'),
  new RegExp(`\\b${jwtName}\\s*[:=]\\s*['"][^'"]{6,}['"]`, 'i'),
  new RegExp(`\\b${dbName}\\s*[:=]\\s*['"]postgres(?:ql)?:\\/\\/`, 'i'),
  new RegExp(`\\b${roleName}\\s*[:=]\\s*['"][^'"]{6,}['"]`, 'i'),
  new RegExp(`\\b${roleShort}\\s*[:=]\\s*['"][^'"]{6,}['"]`, 'i'),
]

export interface FrontendFile {
  abs: string
  rel: string
  text: string
}

const SKIP_DIRS = new Set(['node_modules', 'dist', '.git'])

export function listFiles(dir: string): string[] {
  if (!existsSync(dir)) return []
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(full))
    else if (entry.isFile()) out.push(full)
  }
  return out
}

export function frontendFiles(): FrontendFile[] {
  return listFiles(FRONTEND_ROOT).map((abs) => ({
    abs,
    rel: relative(FRONTEND_ROOT, abs).split('\\').join('/'),
    text: readFileSync(abs, 'utf8'),
  }))
}

/** Arquivos de código do root único. A árvore movida (`src/`) é incluída. */
export function sourceFiles(): FrontendFile[] {
  const exts = new Set(['.ts', '.tsx', '.mjs', '.js', '.html'])
  return frontendFiles().filter((f) => exts.has(extname(f.abs)))
}

/** Código frontend-native (contrato, sessão, entry, testes) — sem a árvore herdada. */
export function nativeFiles(): FrontendFile[] {
  return frontendFiles().filter((f) => !f.rel.startsWith('src/'))
}

export function specText(): string {
  return readFileSync(SPEC_PATH, 'utf8')
}

export function tasksText(): string {
  return readFileSync(TASKS_PATH, 'utf8')
}

export function gitDiff(paths: string[]): string {
  const args = (base: string[]) => ['diff', ...base, '--', ...paths]
  try {
    return execFileSync('git', args(['origin/develop']), {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return execFileSync('git', args([]), {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  }
}

export function exists(relOrAbs: string): boolean {
  const abs = resolve(FRONTEND_ROOT, relOrAbs)
  return existsSync(abs) && statSync(abs).isFile()
}

/** Specifiers de import/export relativos, por arquivo-fonte. */
export function importSpecifiers(text: string): string[] {
  const out: string[] = []
  const re = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"]([^'"]+)['"]/g
  for (const m of text.matchAll(re)) out.push(m[1]!)
  return out
}

/** Specifier relativo que resolve para fora do root único ou do contrato congelado. */
export function legacyImports(): Array<{ file: string; specifier: string }> {
  const contract = resolve(REPO_ROOT, 'backend/libs/shared-contracts')
  const hits: Array<{ file: string; specifier: string }> = []
  for (const file of sourceFiles().filter((f) => f.rel.startsWith('src/') || f.rel === 'main.tsx')) {
    for (const spec of importSpecifiers(file.text)) {
      if (!spec.startsWith('.')) continue
      const abs = resolve(dirname(file.abs), spec)
      if (!abs.startsWith(FRONTEND_ROOT + '/') && !abs.startsWith(contract + '/')) {
        hits.push({ file: file.rel, specifier: spec })
      }
    }
  }
  return hits
}

/** Scanner puro sobre tokens globais; funciona com fixtures em memória. */
export function findForbidden(files: ReadonlyArray<FrontendFile>): Array<{ file: string; token: string }> {
  const hits: Array<{ file: string; token: string }> = []
  for (const file of files) {
    const lower = file.text.toLowerCase()
    for (const [name, token] of Object.entries(FORBIDDEN)) {
      if (token && lower.includes(token.toLowerCase())) hits.push({ file: file.rel, token: name })
    }
  }
  return hits
}

/** Tokens globais proibidos só no código frontend-native (não na árvore herdada). */
export function forbiddenHits(): Array<{ file: string; token: string }> {
  return findForbidden(nativeFiles())
}

/** Dívida localizada: ocorrência em arquivo NÃO pinado no manifesto ⇒ reprova. */
export function debtHits(files: ReadonlyArray<FrontendFile> = frontendFiles()): Array<{ file: string; token: string }> {
  const hits: Array<{ file: string; token: string }> = []
  for (const file of files) {
    if (isDebtPinned(file.rel)) continue
    const lower = file.text.toLowerCase()
    for (const [name, token] of [['remote', remote], ['remoteEnv', remoteEnv]] as const) {
      if (lower.includes(token.toLowerCase())) hits.push({ file: file.rel, token: name })
    }
  }
  return hits
}

/** Material de credencial real em frontend/ e no bundle. */
export function secretPatternHits(files: ReadonlyArray<FrontendFile> = frontendFiles()): Array<{ file: string; token: string }> {
  const hits: Array<{ file: string; token: string }> = []
  for (const file of files) {
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(file.text)) hits.push({ file: file.rel, token: pattern.source })
    }
  }
  return hits
}

export function bundleFiles(): FrontendFile[] {
  const dir = join(REPO_ROOT, 'dist')
  if (!existsSync(dir)) return []
  return listFiles(dir).map((abs) => ({
    abs,
    rel: relative(REPO_ROOT, abs).split('\\').join('/'),
    text: readFileSync(abs, 'utf8'),
  }))
}

export function sectionOf(text: string, number: number): string {
  const re = new RegExp(`^##[ \\t]+${number}\\.[ \\t]*.*$`, 'm')
  const match = re.exec(text)
  if (!match) return ''
  const start = match.index + match[0].length
  const rest = text.slice(start)
  const next = /^##[ \t]+\d+\.[ \t]*.*$/m.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}
