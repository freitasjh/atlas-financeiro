#!/usr/bin/env node
/**
 * D-HARD — detecta overwrite do installer nos arquivos que o projeto CUSTOMIZA.
 *
 * Contexto: o installer copia `../harness-templates/src/**` para `src/`. Ele já
 * apagou a migração da vitrine de /contas e, numa segunda passada, sobrescreveu
 * 68 arquivos (layouts, navigation, dashboard, ui, index.css, lib). Mtime é
 * frágil; a prova é CONTEÚDO (sha256).
 *
 * Contrato:
 *   - gerenciado = interseção `templateDir/**` × `src/**`;
 *   - protegido (manifesto) = gerenciado que DIVERGE do template — arquivo
 *     idêntico ao template não tem o que proteger (o installer reescreveria o
 *     mesmo byte);
 *   - o manifesto declara `managedCount` (tamanho do universo gerenciado) e o
 *     check confere: cobertura não pode encolher em silêncio;
 *   - denúncia dupla: hash divergente do manifesto e/ou arquivo que já era
 *     customizado e voltou a ser byte-idêntico ao template;
 *   - `--audit`: divergentes fora do manifesto (CI);
 *   - `--update`: regrava hashes do projeto; **fail-closed sem repo irmão**
 *     (`--allow-missing-template` é o escape consciente); recusa legitimar
 *     overwrite (`--allow-template-identical` é o escape consciente);
 *   - sem repo irmão: comparações de escopo viram `skip` informativo.
 *
 * Saída determinística: ordem estável por path, sem timestamps.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const MANIFEST_RELATIVE = join('harness', 'template-overrides.json')
const UPDATE_HINT = 'npm run check:template-overrides -- --update'
const MANIFEST_VERSION = 2
const SOURCE_PREFIX = 'src'
const SHA256 = /^[0-9a-f]{64}$/

/** Path absoluto do manifesto para uma raiz de projeto. */
export function manifestPathFor(root) {
  return join(root, MANIFEST_RELATIVE)
}

/** sha256 hex de um arquivo. */
export function hashFile(absolutePath) {
  return createHash('sha256').update(readFileSync(absolutePath)).digest('hex')
}

class ManifestError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

/** Valida uma entrada do manifesto; devolve o motivo quando inválida. */
function entryProblem(entry) {
  if (!entry || typeof entry !== 'object') return 'entrada não é objeto'
  if (typeof entry.path !== 'string' || !entry.path.startsWith(`${SOURCE_PREFIX}/`)) {
    return `path inválido (${JSON.stringify(entry.path)})`
  }
  if (typeof entry.sha256 !== 'string' || !SHA256.test(entry.sha256)) {
    return `sha256 inválido para ${entry.path}`
  }
  return null
}

/**
 * Lê o manifesto; lança se ausente, vazio, de outra versão, com entradas
 * inválidas ou sem `managedCount` numérico.
 */
export function readManifest(root) {
  const manifestPath = manifestPathFor(root)
  if (!existsSync(manifestPath)) {
    throw new ManifestError('manifest-missing', `manifesto ausente: ${manifestPath}`)
  }

  let parsed
  try {
    parsed = JSON.parse(readFileSync(manifestPath, 'utf8'))
  } catch {
    throw new ManifestError('manifest-invalid', `manifesto ilegível (JSON inválido): ${manifestPath}`)
  }

  if (parsed?.version !== MANIFEST_VERSION) {
    throw new ManifestError(
      'manifest-version',
      `manifesto na versão ${JSON.stringify(parsed?.version)}; esperado ${MANIFEST_VERSION}`,
    )
  }
  if (!Array.isArray(parsed.files)) {
    throw new ManifestError('manifest-invalid', `manifesto inválido (files ausente): ${manifestPath}`)
  }
  if (parsed.files.length === 0) {
    throw new ManifestError(
      'manifest-empty',
      `manifesto vazio: proteção inativa (${manifestPath} não protege nenhum arquivo)`,
    )
  }

  const problems = parsed.files.map(entryProblem).filter(Boolean)
  if (problems.length > 0) {
    throw new ManifestError(
      'manifest-invalid-entries',
      `manifesto com ${problems.length} entrada(s) inválida(s): ${problems.slice(0, 5).join('; ')}`,
    )
  }

  if (typeof parsed.managedCount !== 'number' || parsed.managedCount < parsed.files.length) {
    throw new ManifestError(
      'manifest-managed-count',
      `manifesto sem managedCount coerente (declarado ${JSON.stringify(parsed.managedCount)}, protegidos ${parsed.files.length})`,
    )
  }

  return parsed
}

/** Normaliza entradas: dedupe por path, ordem estável. */
function normalizeFiles(files) {
  const byPath = new Map()
  for (const file of files) {
    if (typeof file?.path !== 'string' || file.path.length === 0) continue
    byPath.set(file.path, file)
  }
  return [...byPath.keys()].sort().map((path) => byPath.get(path))
}

function serializeManifest(manifest) {
  const files = normalizeFiles(manifest.files).map(({ path, sha256 }) => ({ path, sha256: sha256 ?? '' }))
  const normalized = {
    version: MANIFEST_VERSION,
    ...(manifest.description ? { description: manifest.description } : {}),
    templateDir: manifest.templateDir,
    managedCount: typeof manifest.managedCount === 'number' ? manifest.managedCount : files.length,
    files,
  }
  return JSON.stringify(normalized, null, 2) + '\n'
}

/** Grava o manifesto normalizado (ordem estável) e devolve o texto final. */
export function writeManifest(root, manifest) {
  const manifestPath = manifestPathFor(root)
  mkdirSync(dirname(manifestPath), { recursive: true })
  const text = serializeManifest(manifest)
  writeFileSync(manifestPath, text, 'utf8')
  return text
}

function walkFiles(absoluteDir, baseDir = absoluteDir, acc = []) {
  if (!existsSync(absoluteDir)) return acc
  for (const entry of readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolute = join(absoluteDir, entry.name)
    if (entry.isDirectory()) {
      walkFiles(absolute, baseDir, acc)
    } else if (entry.isFile()) {
      acc.push(relative(baseDir, absolute).split(sep).join('/'))
    }
  }
  return acc
}

/** Raiz do template declarada pelo manifesto (ou null). */
export function templateRootFor(root, templateDir) {
  if (typeof templateDir !== 'string' || templateDir.trim() === '') return null
  return resolve(root, templateDir)
}

/** Arquivos gerenciados: interseção template × projeto (relativos à raiz). */
export function listManagedFiles({ root, templateDir }) {
  const templateRoot = templateRootFor(root, templateDir)
  if (!templateRoot || !existsSync(templateRoot)) return []
  const managed = []
  for (const rel of walkFiles(templateRoot)) {
    const projectRelative = join(SOURCE_PREFIX, rel).split(sep).join('/')
    if (existsSync(join(root, projectRelative))) managed.push(projectRelative)
  }
  return managed.sort()
}

/**
 * Arquivos gerenciados que DIVERGEM do template — universo protegível.
 * Arquivo byte-idêntico ao template não tem o que proteger.
 */
export function listDivergentFiles({ root, templateDir }) {
  const templateRoot = templateRootFor(root, templateDir)
  if (!templateRoot || !existsSync(templateRoot)) return []
  const divergent = []
  for (const path of listManagedFiles({ root, templateDir })) {
    const relativeToSrc = relative(SOURCE_PREFIX, path)
    const candidate = join(templateRoot, relativeToSrc)
    if (!existsSync(candidate)) continue
    if (hashFile(join(root, path)) !== hashFile(candidate)) divergent.push(path)
  }
  return divergent.sort()
}

/** Caminho do arquivo correspondente no repo irmão (ou null). */
function templateCandidate(root, templateDir, entryPath) {
  const templateRoot = templateRootFor(root, templateDir)
  if (!templateRoot) return null
  const relativeToSrc = relative(SOURCE_PREFIX, entryPath)
  if (relativeToSrc.startsWith('..')) return null
  return { templateRoot, candidate: join(templateRoot, relativeToSrc) }
}

/**
 * Compara manifesto x disco (+ auditoria de divergentes e comparação cruzada
 * com o template quando o repo irmão existe). Puro: nenhum efeito colateral.
 */
export function buildReport({ root }) {
  const report = {
    status: 'ok',
    exitCode: 0,
    checked: 0,
    managed: 0,
    crossCheckAvailable: false,
    failures: [],
    skipped: [],
    manifestPath: manifestPathFor(root),
  }

  let manifest
  try {
    manifest = readManifest(root)
  } catch (error) {
    report.status = 'fail'
    report.exitCode = 1
    report.failures.push({
      path: report.manifestPath,
      kind: error?.code ?? 'manifest-missing',
      detail: error instanceof Error ? error.message : String(error),
    })
    return report
  }

  const entries = normalizeFiles(manifest.files)
  report.checked = entries.length

  const templateDir = manifest.templateDir
  const templateRoot = templateRootFor(root, templateDir)
  if (!templateRoot) {
    // H2: sem templateDir a comparação cruzada (sinal de overwrite) é inativa.
    report.failures.push({
      path: report.manifestPath,
      kind: 'template-dir-missing',
      detail: 'templateDir ausente/vazio no manifesto',
    })
  } else if (!existsSync(templateRoot)) {
    report.skipped.push(`comparação cruzada (${templateDir} ausente)`)
  } else {
    report.crossCheckAvailable = true
    const managed = listManagedFiles({ root, templateDir })
    report.managed = managed.length
    if (managed.length === 0) {
      report.failures.push({
        path: report.manifestPath,
        kind: 'template-layout-mismatch',
        detail: `templateDir "${templateDir}" não tem correspondência em src/`,
      })
    } else if (manifest.managedCount !== managed.length) {
      report.failures.push({
        path: report.manifestPath,
        kind: 'managed-count-mismatch',
        detail: `manifesto declara managedCount=${manifest.managedCount}, universo real=${managed.length}`,
      })
    }

    const divergent = new Set(listDivergentFiles({ root, templateDir }))
    const registered = new Set(entries.map((entry) => entry.path))
    for (const path of [...divergent].sort()) {
      if (!registered.has(path)) report.failures.push({ path, kind: 'unmanaged-file' })
    }
  }

  for (const entry of entries) {
    const absolute = join(root, entry.path)
    if (!existsSync(absolute)) {
      report.failures.push({ path: entry.path, kind: 'missing-file' })
      continue
    }

    const actual = hashFile(absolute)
    const hashMatches = entry.sha256 === actual
    if (!hashMatches) {
      report.failures.push({ path: entry.path, kind: 'hash-mismatch', expected: entry.sha256, actual })
    }

    // Diagnóstico: já foi customizado e voltou a ser igual ao template.
    const candidateInfo = templateCandidate(root, templateDir, entry.path)
    if (
      !hashMatches &&
      candidateInfo &&
      existsSync(candidateInfo.candidate) &&
      readFileSync(candidateInfo.candidate).equals(readFileSync(absolute))
    ) {
      report.failures.push({ path: entry.path, kind: 'template-identical', templateDir })
    }
  }

  report.failures.sort((a, b) => a.path.localeCompare(b.path) || a.kind.localeCompare(b.kind))
  if (report.failures.length > 0) {
    report.status = 'fail'
    report.exitCode = 1
  }
  return report
}

/**
 * Regrava o manifesto a partir do projeto: protege apenas divergentes,
 * adiciona os que passaram a divergir, remove os que voltaram a ser idênticos.
 * Fail-closed sem repo irmão e recusa legitimar overwrite.
 */
export function updateManifest({ root, allowTemplateIdentical = false, allowMissingTemplate = false }) {
  const manifest = readManifest(root)
  const templateDir = manifest.templateDir
  const templateRoot = templateRootFor(root, templateDir)
  const entries = normalizeFiles(manifest.files)
  const previous = new Map(entries.map((entry) => [entry.path, entry.sha256]))

  if (!templateRoot) {
    throw new Error('templateDir ausente no manifesto — declare a raiz `src` do repo irmão')
  }

  if (!existsSync(templateRoot)) {
    if (!allowMissingTemplate) {
      throw new Error(
        `repo irmão ausente (${templateDir}): sem ele não é possível provar divergência — ` +
          `restaure a customização a partir de .harness-backup/<ts>/ ou autorize explicitamente com --allow-missing-template`,
      )
    }
    const files = entries.map(({ path }) => ({ path, sha256: hashFile(join(root, path)) }))
    return writeManifest(root, { ...manifest, files })
  }

  const managed = listManagedFiles({ root, templateDir })
  const divergent = new Set(listDivergentFiles({ root, templateDir }))
  const overwritten = []
  const next = new Map()

  const record = (path) => {
    const absolute = join(root, path)
    if (!existsSync(absolute)) {
      throw new Error(`arquivo ausente: ${path} — remova a entrada do manifesto ou restaure o arquivo`)
    }
    next.set(path, hashFile(absolute))
    return previous.get(path)
  }

  for (const entry of entries) {
    // Arquivo customizado que sumiu do projeto é erro explícito (não prune mudo).
    if (!existsSync(join(root, entry.path))) {
      throw new Error(`arquivo ausente: ${entry.path} — remova a entrada do manifesto ou restaure o arquivo`)
    }
    if (!managed.includes(entry.path)) continue // template não fornece mais ⇒ sai do manifesto
    if (divergent.has(entry.path)) {
      record(entry.path)
      continue
    }
    if (allowTemplateIdentical) {
      record(entry.path)
      continue
    }
    const candidateInfo = templateCandidate(root, templateDir, entry.path)
    const templateHash = candidateInfo && existsSync(candidateInfo.candidate) ? hashFile(candidateInfo.candidate) : null
    const wasCustomized = previous.has(entry.path) && templateHash !== null && previous.get(entry.path) !== templateHash
    if (wasCustomized) overwritten.push(entry.path) // mantém a entrada para o erro persistir
  }

  for (const path of [...divergent].sort()) {
    if (!next.has(path)) record(path)
  }

  if (overwritten.length > 0) {
    throw new Error(
      `idêntico ao harness-templates: ${overwritten.sort().join(', ')} — ` +
        'isso é assinatura de overwrite do installer; restaure de .harness-backup/<ts>/ ' +
        'ou use --allow-template-identical se for intencional',
    )
  }

  const files = [...next.keys()].sort().map((path) => ({ path, sha256: next.get(path) }))
  return writeManifest(root, { ...manifest, managedCount: managed.length, files })
}

function plural(count, singular, pluralForm) {
  return `${count} ${count === 1 ? singular : pluralForm}`
}

/** Texto determinístico do relatório (sem timestamps). */
export function formatReport(report) {
  const lines = []
  if (report.status === 'ok') {
    lines.push(
      report.crossCheckAvailable
        ? `template-overrides: OK (${plural(report.checked, 'divergente protegido', 'divergentes protegidos')} de ${plural(report.managed, 'gerenciado', 'gerenciados')})`
        : `template-overrides: OK (${plural(report.checked, 'arquivo', 'arquivos')})`,
    )
  } else {
    lines.push(`template-overrides: FALHOU (${plural(report.failures.length, 'problema', 'problemas')})`)
    for (const failure of report.failures) {
      switch (failure.kind) {
        case 'manifest-missing':
          lines.push(`  - manifesto ausente: ${failure.path}`)
          lines.push(`    crie a lista de arquivos e rode: ${UPDATE_HINT}`)
          break
        case 'manifest-empty':
          lines.push(`  - manifesto vazio: proteção inativa (${failure.path})`)
          lines.push('    liste pelo menos um arquivo customizado e rode: ' + UPDATE_HINT)
          break
        case 'manifest-version':
        case 'manifest-invalid':
        case 'manifest-invalid-entries':
        case 'manifest-managed-count':
          lines.push(`  - ${failure.detail ?? failure.kind}: ${failure.path}`)
          lines.push(`    corrija o manifesto ou regenere com: ${UPDATE_HINT}`)
          break
        case 'template-dir-missing':
          lines.push(`  - templateDir ausente/vazio no manifesto (${failure.path})`)
          lines.push('    declare o caminho do repo irmão; sem ele a comparação cruzada fica inativa')
          break
        case 'template-layout-mismatch':
          lines.push(`  - templateDir sem correspondência em src/: ${failure.detail ?? failure.path}`)
          lines.push('    aponte templateDir para a raiz `src` do repo irmão')
          break
        case 'managed-count-mismatch':
          lines.push(`  - cobertura declarada divergiu do universo real: ${failure.detail ?? failure.path}`)
          lines.push(`    rode: ${UPDATE_HINT}`)
          break
        case 'unmanaged-file':
          lines.push(`  - divergente fora do manifesto: ${failure.path}`)
          lines.push(`    rode: ${UPDATE_HINT} (o arquivo passa a ser protegido)`)
          break
        case 'missing-file':
          lines.push(`  - arquivo ausente: ${failure.path}`)
          lines.push('    remova a entrada do manifesto ou restaure o arquivo')
          break
        case 'hash-mismatch':
          lines.push(`  - conteúdo divergente: ${failure.path}`)
          lines.push(
            `    esperado ${String(failure.expected).slice(0, 12)}… • atual ${String(failure.actual).slice(0, 12)}…`,
          )
          lines.push(
            report.crossCheckAvailable
              ? `    se a mudança é legítima: ${UPDATE_HINT}`
              : '    repo irmão ausente: restaure de .harness-backup/<ts>/ ou rode --update --allow-missing-template sob sua responsabilidade',
          )
          break
        case 'template-identical':
          lines.push(`  - idêntico ao harness-templates: ${failure.path}`)
          lines.push(
            `    o installer provavelmente sobrescreveu a customização (${failure.templateDir}); restaure de .harness-backup/<ts>/`,
          )
          break
        default:
          lines.push(`  - ${failure.kind}: ${failure.path}`)
      }
    }
    if (!report.failures.some((failure) => failure.kind === 'hash-mismatch')) {
      lines.push(`  para regenerar após mudança legítima: ${UPDATE_HINT}`)
    }
  }
  for (const skip of report.skipped) {
    lines.push(`template-overrides: skip — ${skip}`)
  }
  return lines.join('\n')
}

/**
 * Auditoria: divergentes fora do manifesto. Mesmo veredito de escopo do check
 * (fail-closed quando o repo irmão existe; `skip` só quando ele não existe).
 */
export function formatAudit({ root }) {
  let manifest
  try {
    manifest = readManifest(root)
  } catch (error) {
    return { lines: [`template-overrides: audit FALHOU — ${error.message}`], exitCode: 1, missing: [] }
  }

  const templateDir = manifest.templateDir
  const templateRoot = templateRootFor(root, templateDir)
  if (!templateRoot) {
    return {
      lines: [`template-overrides: audit FALHOU — templateDir ausente/vazio no manifesto`],
      exitCode: 1,
      missing: [],
    }
  }
  if (!existsSync(templateRoot)) {
    return {
      lines: [
        `template-overrides: audit skip — ${templateDir} não encontrado (sem repo irmão não há como provar escopo)`,
      ],
      exitCode: 0,
      missing: [],
    }
  }

  const managed = listManagedFiles({ root, templateDir })
  if (managed.length === 0) {
    return {
      lines: [`template-overrides: audit FALHOU — templateDir "${templateDir}" sem correspondência em src/`],
      exitCode: 1,
      missing: [],
    }
  }

  const divergent = listDivergentFiles({ root, templateDir })
  const registered = new Set(normalizeFiles(manifest.files).map((entry) => entry.path))
  const missing = divergent.filter((path) => !registered.has(path))
  const lines = [
    `template-overrides: audit — ${plural(managed.length, 'gerenciado', 'gerenciados')}, ` +
      `${plural(divergent.length, 'divergente', 'divergentes')}, ` +
      `${plural(registered.size, 'protegido', 'protegidos')}`,
  ]
  if (manifest.managedCount !== managed.length) {
    lines.push(`  managedCount declarado (${manifest.managedCount}) ≠ universo real (${managed.length})`)
    lines.push(`  rode: ${UPDATE_HINT}`)
    return { lines, exitCode: 1, missing }
  }
  if (missing.length > 0) {
    lines.push(`  divergentes fora do manifesto (${missing.length}):`)
    for (const path of missing) lines.push(`  - ${path}`)
    lines.push(`  rode: ${UPDATE_HINT}`)
    return { lines, exitCode: 1, missing }
  }
  lines.push('  nenhum divergente fora do manifesto')
  return { lines, exitCode: 0, missing }
}

export function main(argv = process.argv.slice(2)) {
  const rootFlag = argv.indexOf('--root')
  const root = rootFlag >= 0 ? resolve(argv[rootFlag + 1] ?? '.') : process.cwd()

  if (argv.includes('--update')) {
    try {
      const text = updateManifest({
        root,
        allowTemplateIdentical: argv.includes('--allow-template-identical'),
        allowMissingTemplate: argv.includes('--allow-missing-template'),
      })
      const files = JSON.parse(text).files
      process.stdout.write(`template-overrides: atualizado (${plural(files.length, 'arquivo', 'arquivos')})\n`)
      return 0
    } catch (error) {
      process.stderr.write(`template-overrides: FALHOU — ${error instanceof Error ? error.message : String(error)}\n`)
      return 1
    }
  }

  if (argv.includes('--audit')) {
    const audit = formatAudit({ root })
    const stream = audit.exitCode === 0 ? process.stdout : process.stderr
    stream.write(`${audit.lines.join('\n')}\n`)
    return audit.exitCode
  }

  const report = buildReport({ root })
  const text = formatReport(report)
  if (report.status === 'ok') {
    process.stdout.write(`${text}\n`)
  } else {
    process.stderr.write(`${text}\n`)
  }
  return report.exitCode
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exit(main())
}

export { MANIFEST_RELATIVE, UPDATE_HINT, SOURCE_PREFIX, serializeManifest }
export const __filename = fileURLToPath(import.meta.url)
