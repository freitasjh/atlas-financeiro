// IN-7 — varredura de segredos. Coleta dupla: `git ls-files -z` UNIÃO glob do
// filesystem (.env* e supabase/.temp/**), inclusive arquivos ignorados (🟡-2).
// Saída redigida: arquivo:linha + pattern-id, nunca o valor.

import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

export const ALLOWED_FORMS = [
  /REPLACE_WITH_[A-Z_]+/,
  /^zzfake[0-9a-z]{14}$/,
  /^fake-anon-key-not-a-jwt$/,
  /<PLACEHOLDER_[A-Z_]+>/,
]

export const PATTERNS = [
  { id: 'sb-secret', re: /sb_secret_[A-Za-z0-9_-]{16,}/gi, group: 0 },
  { id: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/gi, group: 0 },
  {
    id: 'service-role',
    re: /\bservice_role\b\s*[:=]\s*["']?([^/"'\s,}\]]+)/gi,
    group: 1,
  },
  { id: 'postgres-url', re: /postgres(?:ql)?:\/\/[^:@\s]+:[^@\s]+@/gi, group: 0 },
  {
    id: 'entropy',
    re: /(?:^|[^A-Za-z0-9_])([A-Za-z0-9_]*(?:TOKEN|SECRET|KEY|PASSWORD|PASS|API)[A-Za-z0-9_]*)\s*[:=]\s*["']?([A-Za-z0-9_\-/+=]{32,})/gi,
    group: 2,
  },
]

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'harness', '.harness-backup', '.opencode', 'build', 'out'])

export function isAllowlisted(value) {
  const text = String(value ?? '').trim()
  if (!text) return true
  return ALLOWED_FORMS.some((form) => form.test(text) || text.includes(text.match(form)?.[0] ?? '\u0000'))
}

export function findSecretPatterns(text) {
  const found = []
  for (const pattern of PATTERNS) {
    for (const match of String(text ?? '').matchAll(pattern.re)) {
      const value = match[pattern.group] ?? match[0]
      // Identificadores de schema (`foreignKeyName`, `columns`, ...) são dados,
      // não credenciais: o nome da chave não casa a semântica de segredo.
      if (pattern.id === 'entropy' && /foreign|name$|columns|references/i.test(match[1] ?? '')) continue
      if (isAllowlisted(value)) continue
      if (!found.includes(pattern.id)) found.push(pattern.id)
    }
  }
  return found
}

function toRelative(path, cwd) {
  const absolute = isAbsolute(path) ? path : resolve(cwd, path)
  return relative(cwd, absolute).split(sep).join('/')
}

function walk(cwd, dir = cwd, acc = []) {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    const rel = toRelative(full, cwd)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      walk(cwd, full, acc)
    } else if (entry.isFile()) {
      if (entry.name.startsWith('.env') || rel.startsWith('supabase/.temp/')) acc.push(rel)
    }
  }
  return acc
}

function inTrackedScope(rel) {
  return rel === 'package.json'
    || rel === 'public/_headers'
    || rel === 'supabase/config.toml'
    || rel === 'workers/asaas-webhook/wrangler.toml'
    || rel.startsWith('.doc/')
    || rel.startsWith('scripts/')
    || rel.startsWith('frontend/src/')
}

export function collectPaths(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  /* guard-exempt: reason=allowlist IN-3 git ls-files local read-only */
  const trackedRaw = execFileSync('git', ['ls-files', '-z'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const trackedPaths = trackedRaw.split('\0').map((p) => toRelative(p, cwd)).filter(inTrackedScope).filter(Boolean)
  const globbedPaths = [...new Set(walk(cwd))].sort()
  const ignoredPaths = []
  for (const rel of globbedPaths) {
    try {
      /* guard-exempt: reason=allowlist IN-3 git check-ignore local read-only */
      execFileSync('git', ['check-ignore', '-q', rel], { cwd, stdio: 'ignore' })
      ignoredPaths.push(rel)
    } catch {
      // Não ignorado — segue na união de qualquer forma.
    }
  }
  return { trackedPaths, globbedPaths, ignoredPaths }
}

export function scan(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const tracked = (options.trackedPaths ?? options.paths ?? []).map((p) => toRelative(p, cwd))
  const globbed = (options.globbedPaths ?? []).map((p) => toRelative(p, cwd))
  const ignoredDeclared = new Set((options.ignoredPaths ?? []).map((p) => toRelative(p, cwd)))
  const paths = [...new Set([...tracked, ...globbed])]
  const findings = []

  for (const rel of paths) {
    let text
    try {
      text = readFileSync(resolve(cwd, rel), 'utf8')
    } catch {
      continue
    }
    const ignored = ignoredDeclared.has(rel) || (globbed.includes(rel) && !tracked.includes(rel))
    text.split(/\r?\n/).forEach((line, index) => {
      for (const patternId of findSecretPatterns(line)) {
        findings.push({ path: rel, line: index + 1, patternId, ignored, redacted: true })
      }
    })
  }

  return {
    secretsFound: findings.length,
    findings,
    trackedCount: tracked.length,
    globbedCount: globbed.length,
  }
}

export function runScanCli(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const collected = collectPaths({ cwd })
  const result = scan({ cwd, ...collected })
  for (const finding of result.findings) {
    console.log(`${finding.path}:${finding.line} ${finding.patternId} REDACTED${finding.ignored ? ' ignored:true' : ''}`)
  }
  console.log(`scan-secrets: ${result.secretsFound} achado(s); arquivos rastreados=${result.trackedCount}, glob=${result.globbedCount}`)
  return result.secretsFound > 0 ? 1 : 0
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) process.exitCode = runScanCli()

// Mantém `dirname` importado para resolução relativa consistente em Windows.
void dirname
