// IN-4 — guard de verbos mutantes. Varre SÍTIOS EXECUTÁVEIS, nunca literais de
// plano, relatório, dados ou da seção de aplicação do runbook (emenda 🟡-1/🟡-3).
// Nenhuma rede; os 24 verbos vêm só de scripts/data/mutating-verbs.json.

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const MUTATING_VERBS_SHA256 = '1d16beb6141f3b5aa4a674553e2f93de7401eb8aa3bd461353933cd6f32d266e'
export const DATA_PATH = 'scripts/data/mutating-verbs.json'
export const RUNBOOK_PATH = '.doc/runbook-deploy-primeiro-corte.md'
export const MARKER = '<!-- FIM VALIDAÇÃO — INÍCIO APLICAÇÃO: NAO EXECUTAR EM VALIDAÇÃO -->'

const VALIDATION_TITLE = '# Validação (executável agora)'
const APPLICATION_TITLE = '# Aplicação (somente humano, após aprovação)'

const ALLOWLIST = [
  'node scripts/validate-deploy.mjs',
  'node scripts/check-dist.mjs',
  'npm run build',
  'supabase --version',
  'supabase config validate',
  'command -v supabase',
  'command -v wrangler',
  'sha256sum',
  'wrangler --version',
  'git rev-parse HEAD',
  'git ls-files -z',
  'git check-ignore -q',
  'git diff --exit-code HEAD -- package.json',
  'node scripts/emit-pages-plan.mjs',
]

const CALL_SOURCE = '\\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync|execa|execaSync|crossSpawn|fork|forkSync)\\s*\\('
const CALL_RE = new RegExp(CALL_SOURCE, 'gi')
const STRING_RE = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g

export function loadVerbs(options = {}) {
  const path = options.path ?? DATA_PATH
  const cwd = options.cwd ?? process.cwd()
  let bytes
  try {
    bytes = readFileSync(resolve(cwd, path))
  } catch {
    throw new Error('verb-source-integrity: arquivo de dados ilegível')
  }
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (sha256 !== MUTATING_VERBS_SHA256) {
    throw new Error('verb-source-integrity: SHA-256 divergente')
  }
  let data
  try {
    data = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('verb-source-integrity: JSON inválido')
  }
  if (data?.schema !== 'mutating-verbs/v1' || !Array.isArray(data.verbs) || data.verbs.length !== 24) {
    throw new Error('verb-source-integrity: schema ou contagem inválida')
  }
  return { path, sha256, verbs: data.verbs }
}

function stripShellComment(line) {
  let quote = null
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (quote) {
      if (ch === quote && line[i - 1] !== '\\') quote = null
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
    } else if (ch === '#') {
      return line.slice(0, i)
    }
  }
  return line
}

export function normalizeCommand(text) {
  return String(text ?? '')
    .split(/\r?\n/)
    .map(stripShellComment)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

export function matchesVerb(command, verbs) {
  const normalized = normalizeCommand(command)
  if (!normalized || !Array.isArray(verbs)) return null
  const tokens = normalized.split(' ')
  const candidates = [...verbs].sort((a, b) => b.length - a.length)
  for (const verb of candidates) {
    const verbTokens = normalizeCommand(verb).split(' ')
    if (verbTokens.length > tokens.length) continue
    for (let i = 0; i <= tokens.length - verbTokens.length; i += 1) {
      if (verbTokens.every((token, j) => tokens[i + j] === token)) return verb
    }
  }
  return null
}

export function isAllowedValidationCommand(command, options = {}) {
  const list = options.allowlist ?? ALLOWLIST
  const normalized = normalizeCommand(command)
  if (!normalized) return false
  return list.some((allowed) => normalizeCommand(allowed) === normalized)
}

export function checkRunbookStructure(text) {
  const source = String(text ?? '')
  const markerCount = source.split(MARKER).length - 1
  const markerIndex = source.indexOf(MARKER)
  const validationIndex = source.indexOf(VALIDATION_TITLE)
  const applicationIndex = source.indexOf(APPLICATION_TITLE)
  const errors = []

  if (markerCount !== 1) errors.push(`marcador de separação presente ${markerCount} vezes (esperado 1)`)
  if (validationIndex < 0) errors.push('seção de validação nomeada incorretamente')
  if (applicationIndex < 0) errors.push('seção de aplicação nomeada incorretamente')
  if (markerIndex >= 0 && validationIndex >= 0 && validationIndex > markerIndex) {
    errors.push('seção de validação depois do marcador')
  }
  if (markerIndex >= 0 && applicationIndex >= 0 && applicationIndex < markerIndex) {
    errors.push('seção de aplicação antes do marcador')
  }
  const validationSection = markerIndex > validationIndex && validationIndex >= 0
    ? source.slice(validationIndex + VALIDATION_TITLE.length, markerIndex)
    : ''
  if (markerCount === 1 && validationSection.replace(/\s/g, '').length === 0) {
    errors.push('seção de validação vazia')
  }
  return { ok: errors.length === 0, markerCount, errors }
}

function extractCallSites(text) {
  const sites = []
  const pattern = new RegExp(CALL_SOURCE, 'gi')
  let match
  while ((match = pattern.exec(text)) !== null) {
    const start = match.index
    const open = text.indexOf('(', start)
    let depth = 0
    let quote = null
    let end = open
    for (let i = open; i < text.length; i += 1) {
      const ch = text[i]
      if (quote) {
        if (ch === quote && text[i - 1] !== '\\') quote = null
      } else if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
      } else if (ch === '(') {
        depth += 1
      } else if (ch === ')') {
        depth -= 1
        if (depth === 0) {
          end = i
          break
        }
      }
    }
    const inner = text.slice(open + 1, end)
    // Opções como `{ encoding: 'utf8' }` não são argumentos de comando.
    const commandArguments = inner.split('{')[0]
    const literals = []
    for (const literal of commandArguments.matchAll(STRING_RE)) literals.push(literal[2])
    const candidates = []
    if (literals.length > 0) candidates.push(literals.join(' '))
    for (const literal of literals) candidates.push(literal)
    for (let i = 0; i < literals.length - 1; i += 1) candidates.push(literals.slice(i, i + 2).join(' '))
    const previousLines = text.slice(0, start).split('\n')
    const previous = previousLines[previousLines.length - 2] ?? ''
    sites.push({
      line: previousLines.length,
      candidates,
      exempt: previous.includes('guard-exempt:'),
      reason: /reason=(.{10,})/.test(previous)
        ? previous.match(/reason=(.{10,})/)?.[1]?.trim() ?? null
        : null,
    })
    pattern.lastIndex = end + 1
  }
  return sites
}

function readPackageJsonDiff(cwd) {
  /* guard-exempt: reason=allowlist IN-3 diff local read-only de package.json */
  const output = execFileSync('git', ['diff', '--exit-code', 'HEAD', '--', 'package.json'], {
    cwd,
    encoding: 'utf8',
  })
  return output.length === 0 ? 'clean' : 'dirty'
}

export function scan(options = {}) {
  const {
    text = '',
    scope = 'validation',
    sources = [],
    runbookText,
    validationText,
    verbPath = DATA_PATH,
    cwd = process.cwd(),
    packageJsonDiff,
  } = options
  const blocked = []
  const exemptions = []
  const errors = []

  let verbData = null
  try {
    verbData = loadVerbs({ path: verbPath, cwd })
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error))
    blocked.push({ file: verbPath, line: 1, verb: 'verb-source-integrity', reason: 'verb-source-integrity' })
  }
  const verbs = verbData?.verbs ?? []
  const verbSource = verbData
    ? { path: verbData.path, sha256: verbData.sha256, verbs: verbData.verbs.length }
    : { path: verbPath, sha256: 'redacted', verbs: 0 }

  if (runbookText !== undefined) {
    const structure = checkRunbookStructure(runbookText)
    if (!structure.ok) {
      for (const message of structure.errors) {
        errors.push(message)
        blocked.push({ file: RUNBOOK_PATH, line: 1, verb: 'fail-closed', reason: message })
      }
    }
  }
  if (validationText !== undefined && normalizeCommand(validationText) === '') {
    errors.push('seção de validação vazia')
    blocked.push({ file: RUNBOOK_PATH, line: 1, verb: 'fail-closed', reason: 'validation-section-empty' })
  }

  const diff = packageJsonDiff ?? 'clean'
  if (diff !== 'clean') {
    errors.push('package.json sujo')
    blocked.push({ file: 'package.json', line: 1, verb: 'fail-closed', reason: 'package-json-diff' })
  }

  if (scope === 'validation' && text) {
    const lines = String(text).split(/\r?\n/)
    lines.forEach((line, index) => {
      if (normalizeCommand(line) === '') return
      const verb = matchesVerb(line, verbs)
      if (verb) blocked.push({ file: 'text', line: index + 1, verb, reason: 'mutating-text' })
    })
  }

  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      blocked.push({ file: 'unknown', line: 1, verb: 'fail-closed', reason: 'unreadable-source' })
      continue
    }
    const file = source.path ?? 'unknown'
    if (source.scripts && typeof source.scripts === 'object') {
      for (const [name, command] of Object.entries(source.scripts)) {
        const verb = matchesVerb(command, verbs)
        if (verb) blocked.push({ file: `${file}:scripts.${name}`, line: 1, verb, reason: 'mutating-script' })
      }
      continue
    }
    if (typeof source.text !== 'string') {
      blocked.push({ file, line: 1, verb: 'fail-closed', reason: 'unreadable-source' })
      continue
    }
    for (const site of extractCallSites(source.text)) {
      let verb = null
      for (const candidate of site.candidates) {
        verb = matchesVerb(candidate, verbs)
        if (verb) break
      }
      const allowed = site.candidates.find(isAllowedValidationCommand) ?? null
      if (verb) {
        blocked.push({ file, line: site.line, verb, reason: 'mutating-site' })
        if (site.exempt) {
          blocked.push({ file, line: site.line, verb: 'invalid-exemption', reason: 'exemption-on-mutating-site' })
        }
        continue
      }
      if (site.exempt && !site.reason) {
        blocked.push({ file, line: site.line, verb: 'invalid-exemption', reason: 'exemption-without-reason' })
        continue
      }
      if (site.exempt) {
        if (!allowed) {
          blocked.push({ file, line: site.line, verb: 'invalid-exemption', reason: 'exemption-not-allowlisted' })
          continue
        }
        exemptions.push({ file, line: site.line, command: allowed, reason: site.reason, redacted: true })
        continue
      }
      if (allowed) {
        blocked.push({ file, line: site.line, verb: 'allowlist', reason: 'allowlisted-site-without-exemption' })
      }
    }
  }

  const count = blocked.length
  return {
    blocked,
    scope,
    count,
    verbSource,
    exemptions,
    packageJsonDiff: diff,
    errors,
    ok: count === 0 && diff === 'clean' && errors.length === 0,
  }
}

export function runGuardCli(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const runbookText = readFileSync(resolve(cwd, RUNBOOK_PATH), 'utf8')
  const names = ['validate-deploy.mjs', 'guard-mutating-verbs.mjs', 'scan-secrets.mjs', 'emit-pages-plan.mjs']
  const sources = names.map((name) => ({ path: `scripts/${name}`, text: readFileSync(resolve(cwd, 'scripts', name), 'utf8') }))
  const pkg = JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8'))
  sources.push({ path: 'package.json', scripts: pkg.scripts })
  const result = scan({ runbookText, sources, cwd, packageJsonDiff: readPackageJsonDiff(cwd) })
  console.log(JSON.stringify(result))
  return result.ok ? 0 : 1
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) process.exitCode = runGuardCli()
