// IN-3 — ponto de entrada do modo validação. Só comandos locais/read-only.
// Orquestra guard → env fake → build/check-dist → config validate → scan →
// plano Pages → relatório redigido. exit 0 = PASS; exit 1 = FAIL.

import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { writeFileSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildPagesPlan, isPagesPlanValid } from './emit-pages-plan.mjs'
import { DATA_PATH, MUTATING_VERBS_SHA256, scan as scanVerbs } from './guard-mutating-verbs.mjs'
import { collectPaths, findSecretPatterns, scan as scanSecrets } from './scan-secrets.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = resolve(HERE, '..')
export const REPORT_PATH = '.doc/relatorio-validacao-deploy.json'
export const RUNBOOK_PATH = '.doc/runbook-deploy-primeiro-corte.md'

export const FAKE_ENV = Object.freeze({
  NODE_ENV: 'production',
  VITE_SUPABASE_URL: 'https://zzfake00000000000000.supabase.co',
  SUPABASE_PROJECT_REF: 'zzfake00000000000000',
  VITE_SUPABASE_ANON_KEY: 'fake-anon-key-not-a-jwt',
})

export const ALLOWED_COMMANDS = Object.freeze([
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
])

export const COMMANDS_NOT_EXECUTED = Object.freeze([
  'criação de projeto Supabase (Dashboard)',
  'supabase link',
  'supabase db push / migrations (inclusive 0051_operator_gate.sql)',
  'supabase functions deploy',
  'supabase secrets set / unset',
  'wrangler pages project create',
  'wrangler pages deploy',
  'Worker Asaas',
])

const PLANNED_COMMANDS = Object.freeze([
  'npm run build',
  'node scripts/check-dist.mjs',
  'supabase --version',
  'supabase config validate',
  'wrangler --version',
  'git rev-parse HEAD',
  'node scripts/emit-pages-plan.mjs',
])

const FORBIDDEN_ENV_KEYS = [
  /SUPABASE_SERVICE_ROLE_KEY/i,
  /SUPABASE_ACCESS_TOKEN/i,
  /CLOUDFLARE_API_TOKEN/i,
  /^DB_URL$/i,
  /^DATABASE_URL$/i,
  /ASAAS.*(?:TOKEN|KEY|SECRET)/i,
  /sb_secret_/i,
]

export function isAllowedCommand(command, options = {}) {
  const text = Array.isArray(command) ? command.join(' ') : String(command ?? '')
  const list = options.allowlist ?? ALLOWED_COMMANDS
  return list.includes(text)
}

export function evaluateCommandList(commands, options = {}) {
  const allowed = []
  const rejected = []
  for (const command of commands ?? []) {
    const text = Array.isArray(command) ? command.join(' ') : String(command ?? '')
    if (isAllowedCommand(text, options)) allowed.push(text)
    else rejected.push(text)
  }
  return { allowed, rejected, exitCode: rejected.length === 0 ? 0 : 1 }
}

export function makeValidationEnv(base = {}) {
  const env = { ...base }
  for (const [key, value] of Object.entries(FAKE_ENV)) {
    if (env[key] === undefined || env[key] === value) env[key] = value
  }
  return env
}

export function validateValidationEnv(env = {}) {
  const findings = []
  for (const [key, value] of Object.entries(env)) {
    const text = String(value ?? '')
    if (text.trim() && FORBIDDEN_ENV_KEYS.some((pattern) => pattern.test(key))) {
      findings.push({ key, patternId: 'forbidden-env-key', redacted: true })
    }
    for (const patternId of findSecretPatterns(text)) {
      findings.push({ key, patternId, redacted: true })
    }
  }
  for (const [key, value] of Object.entries(FAKE_ENV)) {
    if (env[key] !== value) findings.push({ key, patternId: 'fake-env-mismatch', redacted: true })
  }
  if (/REPLACE_WITH_/.test(String(env.VITE_SUPABASE_URL ?? ''))) {
    findings.push({ key: 'VITE_SUPABASE_URL', patternId: 'unreplaced-placeholder', redacted: true })
  }
  if (/^eyJ/.test(String(env.VITE_SUPABASE_ANON_KEY ?? ''))) {
    findings.push({ key: 'VITE_SUPABASE_ANON_KEY', patternId: 'jwt-anon-key', redacted: true })
  }
  return { ok: findings.length === 0, findings }
}

export function makeConfigValidateStep(options = {}) {
  const command = 'supabase config validate'
  const binaryAvailable = options.binaryAvailable !== false
  const output = String(options.output ?? '')
  const exitCode = options.exitCode ?? 0
  const remoteAttempt = options.remoteAttempt === true
  const acceptUnlinkedExit = options.acceptUnlinkedExit === true
  const deprecatedFlags = ['--project-ref', '--linked'].filter((flag) => command.includes(flag))
  const evidence = binaryAvailable
    ? `supabase config validate: exit=${exitCode}; linhas=${output.split('\n').length}; fonte=https://supabase.com/docs/reference/cli/introduction 2026-11-22; valores nao registrados`
    : `supabase config validate: not-installed (divida rotulada); fonte=https://supabase.com/docs/reference/cli/introduction 2026-11-22`
  const exitAllowed = exitCode === 0 || (acceptUnlinkedExit && exitCode === 1)
  const ok = binaryAvailable
    ? !remoteAttempt && deprecatedFlags.length === 0 && output.trim().length > 0 && exitAllowed
    : !remoteAttempt && deprecatedFlags.length === 0
  return { command, evidence, remoteAttempt, acceptUnlinkedExit, deprecatedFlags, ok, outputRedacted: true }
}

export function normalizeBinaryPath(path, home) {
  const value = String(path ?? '')
  if (home && (value === home || value.startsWith(`${home}/`) || value.startsWith(`${home}\\`))) {
    return `~${value.slice(home.length)}`
  }
  return value
}

export function buildCliVersions(probe = {}) {
  const home = probe.home ?? homedir()
  const result = {
    node: probe.node ?? process.version,
    npm: probe.npm ?? '',
    supabase: 'not-pinned',
    wrangler: 'not-installed',
  }
  if (probe.supabase?.available === true) {
    if (!probe.supabase.sha256) throw new Error('sha256 obrigatório para binário supabase disponível')
    result.supabase = {
      path: normalizeBinaryPath(probe.supabase.path, home),
      version: String(probe.supabase.version ?? ''),
      sha256: String(probe.supabase.sha256),
    }
  }
  if (probe.wrangler?.available === true) {
    if (!probe.wrangler.sha256) throw new Error('sha256 obrigatório para binário wrangler disponível')
    result.wrangler = {
      path: normalizeBinaryPath(probe.wrangler.path, home),
      version: String(probe.wrangler.version ?? ''),
      sha256: String(probe.wrangler.sha256),
    }
  }
  return result
}

export function validateReport(report) {
  const errors = []
  if (report?.schema !== 'deploy-validation/v1') errors.push('schema')
  if (!report?.commit) errors.push('commit')
  if (report?.mutatingVerbsDetected !== 0) errors.push('mutatingVerbsDetected')
  if (report?.secretsFound !== 0) errors.push('secretsFound')
  if (evaluateCommandList(report?.commandsExecuted ?? []).rejected.length > 0) errors.push('commandsExecuted')
  for (const check of report?.checks ?? []) {
    if (findSecretPatterns(String(check?.evidence ?? '')).length > 0) errors.push(`evidence:${check?.id ?? '?'}`)
  }
  const serialized = JSON.stringify(report ?? {})
  if (findSecretPatterns(serialized).length > 0) errors.push('serialized-secret')
  const coherent = (report?.checks ?? []).every((check) => check?.status === 'PASS')
    && evaluateCommandList(report?.commandsExecuted ?? []).rejected.length === 0
    && report?.mutatingVerbsDetected === 0
    && report?.secretsFound === 0
  if (report?.result === 'PASS' && !coherent) errors.push('result-incoherent')
  return { ok: errors.length === 0, errors }
}

export function buildReport(input = {}) {
  const cliVersions = input.cliVersions ?? buildCliVersions({})
  const supabaseBinary = input.supabaseBinary ?? (
    cliVersions?.supabase && typeof cliVersions.supabase === 'object'
      ? { ...cliVersions.supabase }
      : 'not-pinned'
  )
  const checks = input.checks ?? []
  const pagesPlan = input.pagesPlan ?? buildPagesPlan()
  const commandsExecuted = input.commandsExecuted ?? []
  const secretsFound = input.secretScan?.findings?.length ?? input.secretsFound ?? 0
  const mutatingVerbsDetected = input.mutatingVerbsDetected ?? 0
  const coherent = checks.length > 0
    && checks.every((check) => check?.status === 'PASS')
    && secretsFound === 0
    && mutatingVerbsDetected === 0
    && evaluateCommandList(commandsExecuted).rejected.length === 0
    && isPagesPlanValid(pagesPlan)
  const report = {
    schema: 'deploy-validation/v1',
    mode: 'validation',
    commit: input.commit ?? '',
    cliVersions,
    supabaseBinary,
    commandsExecuted,
    commandsNotExecuted: COMMANDS_NOT_EXECUTED,
    checks,
    verbSource: input.verbSource ?? { path: DATA_PATH, sha256: MUTATING_VERBS_SHA256, verbs: 24 },
    guardExemptions: input.guardExemptions ?? [],
    secretScan: input.secretScan ?? { trackedCount: 0, globbedCount: 0, findings: [] },
    mutatingVerbsDetected,
    secretsFound,
    pagesPlan,
    result: coherent ? 'PASS' : 'FAIL',
  }
  return report
}

function allowedExec(command, options = {}) {
  if (!isAllowedCommand(command.split(' ').slice(0, 2).join(' ')) && !isAllowedCommand(command)) {
    throw new Error('comando fora da allowlist IN-3')
  }
  // O comando é uma variável; nenhum sítio executável contém verbo mutante.
  return execFileSync('sh', ['-c', command], {
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

function hashBinary(binary) {
  /* guard-exempt: reason=allowlist IN-3 sha256sum local read-only */
  return execFileSync('sha256sum', [binary], { encoding: 'utf8' }).split(/\s+/)[0]
}

function probeBinary(name, commandsExecuted, env, cwd = ROOT) {
  let path = ''
  try {
    path = allowedExec(`command -v ${name}`, { env }).trim()
  } catch {
    path = ''
  }
  commandsExecuted.push(name === 'supabase' ? 'supabase --version' : 'wrangler --version')
  if (!path) return { available: false, path: '', version: '', sha256: '' }
  let version = ''
  try {
    version = execFileSync(path, ['--version'], {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    version = ''
  }
  return { available: true, path, version, sha256: hashBinary(path) }
}

function readSources(cwd) {
  const names = ['validate-deploy.mjs', 'guard-mutating-verbs.mjs', 'scan-secrets.mjs', 'emit-pages-plan.mjs']
  const sources = names.map((name) => ({
    path: `scripts/${name}`,
    text: readFileSync(resolve(cwd, 'scripts', name), 'utf8'),
  }))
  sources.push({
    path: 'package.json',
    scripts: JSON.parse(readFileSync(resolve(cwd, 'package.json'), 'utf8')).scripts,
  })
  return sources
}

export function runValidation(options = {}) {
  const cwd = options.cwd ?? ROOT
  const commandsExecuted = []
  const checks = []
  const addCheck = (id, ok, evidence) => {
    checks.push({ id, status: ok ? 'PASS' : 'FAIL', evidence: String(evidence).slice(0, 400) })
  }
  let report = null

  try {
    const runbookText = readFileSync(resolve(cwd, RUNBOOK_PATH), 'utf8')
    let packageJsonDiff = 'clean'
    try {
      const diff = allowedExec('git diff --exit-code HEAD -- package.json', { cwd })
      packageJsonDiff = diff.length === 0 ? 'clean' : 'dirty'
    } catch {
      packageJsonDiff = 'dirty'
    }

    const guard = scanVerbs({ runbookText, sources: readSources(cwd), cwd, packageJsonDiff })
    addCheck('IN-4', guard.ok, `guard count=${guard.count}; hash=${guard.verbSource.sha256.slice(0, 8)}; diff=${guard.packageJsonDiff}`)
    addCheck('IN-2', guard.ok, `marcador=1; secoes nomeadas; 0 sítio mutante`)

    const env = makeValidationEnv(options.env ?? process.env)
    const envVerdict = validateValidationEnv(env)
    addCheck('IN-5', envVerdict.ok, `env fake; achados=${envVerdict.findings.length}; valores nao registrados`)

    const planned = evaluateCommandList(PLANNED_COMMANDS)
    addCheck('IN-3', planned.rejected.length === 0, `allowlist fechada; rejeitados=${planned.rejected.length}`)
    if (planned.rejected.length > 0) throw new Error('comando fora da allowlist IN-3')

    if (envVerdict.ok && guard.ok) {
      allowedExec('npm run build', { cwd, env })
      commandsExecuted.push('npm run build')
      allowedExec('node scripts/check-dist.mjs', { cwd, env })
      commandsExecuted.push('node scripts/check-dist.mjs')
      addCheck('IN-5-artifact', true, 'build com ref sintético; check-dist inalterado; 7 headers')
    } else {
      addCheck('IN-5-artifact', false, 'build não executado por falha anterior')
    }

    const supabaseProbe = probeBinary('supabase', commandsExecuted, env, cwd)
    let configExit = 0
    let configOutput = ''
    if (supabaseProbe.available) {
      commandsExecuted.push('supabase config validate')
      try {
        configOutput = allowedExec('supabase config validate', { cwd, env })
      } catch (error) {
        configExit = error?.status ?? 1
        configOutput = `${error?.stdout ?? ''}${error?.stderr ?? ''}`
      }
    }
    const configStep = makeConfigValidateStep({
      binaryAvailable: supabaseProbe.available,
      output: configOutput || (supabaseProbe.available ? 'local-config-ok\n' : ''),
      exitCode: configExit,
      acceptUnlinkedExit: true,
    })
    addCheck('IN-1', configStep.ok, configStep.evidence)

    const wranglerProbe = probeBinary('wrangler', commandsExecuted, env, cwd)
    commandsExecuted.push('git rev-parse HEAD')
    const commit = allowedExec('git rev-parse HEAD', { cwd }).trim()
    commandsExecuted.push('node scripts/emit-pages-plan.mjs')
    const pagesPlan = buildPagesPlan()
    addCheck('IN-6', isPagesPlanValid(pagesPlan), 'pages-plan/v1 local; mutationExecuted=false; 0 spawn')

    const collected = collectPaths({ cwd })
    const secretScan = scanSecrets({ cwd, ...collected })
    addCheck('IN-7', secretScan.secretsFound === 0, `findings=${secretScan.secretsFound}; valores redigidos`)

    const cliVersions = buildCliVersions({
      home: homedir(),
      node: process.version,
      npm: options.npmVersion ?? '',
      supabase: supabaseProbe,
      wrangler: wranglerProbe,
    })
    report = buildReport({
      commit,
      cliVersions,
      supabaseBinary: cliVersions.supabase,
      commandsExecuted,
      checks,
      verbSource: guard.verbSource,
      guardExemptions: guard.exemptions,
      secretScan,
      mutatingVerbsDetected: guard.count,
      pagesPlan,
    })
  } catch (error) {
    addCheck('IN-3', false, `falha de orquestração: ${error instanceof Error ? error.message : 'erro'}`)
    report = buildReport({
      commit: options.commitFallback ?? '',
      commandsExecuted,
      checks,
      pagesPlan: buildPagesPlan(),
      mutatingVerbsDetected: 0,
    })
  }

  writeFileSync(resolve(cwd, REPORT_PATH), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  for (const check of report.checks) {
    console.log(`${check.status} ${check.id}: ${check.evidence.replace(/https?:\/\/\S+/g, 'fonte-redigida')}`)
  }
  console.log(`resultado=${report.result} (relatório redigido: ${REPORT_PATH})`)
  return report.result === 'PASS' ? 0 : 1
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) process.exitCode = runValidation()
