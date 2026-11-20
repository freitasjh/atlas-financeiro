import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  buildReport,
  formatAudit,
  formatReport,
  hashFile,
  listDivergentFiles,
  listManagedFiles,
  manifestPathFor,
  readManifest,
  updateManifest,
} from '../../scripts/check-template-overwrite.mjs'

interface Fixture {
  root: string
  templateRoot: string
  base: string
  cleanup: () => void
}

const TEMPLATE_DIR = '../harness-templates/src'
/** Customizado (difere do template) — protegível. */
const CUSTOM = 'src/components/shadcn/bank-accounts/custom.tsx'
/** Customizado em navigation — usado na prova de overwrite. */
const NAV = 'src/components/shadcn/navigation/app-sidebar.tsx'
/** Gerenciado, mas byte-idêntico ao template — fora do manifesto (A-1). */
const UNTOUCHED = 'src/components/shadcn/ui/button.tsx'
/** Só existe no projeto. */
const PROJECT_ONLY = 'src/modules/accounts/local.ts'
/** Só existe no template. */
const TEMPLATE_ONLY = 'components/shadcn/ui/new-widget.tsx'
const MANAGED_COUNT = 3

const TEMPLATE_FILES: Record<string, string> = {
  'components/shadcn/bank-accounts/custom.tsx': 'template-body\n',
  'components/shadcn/navigation/app-sidebar.tsx': 'template-nav\n',
  'components/shadcn/ui/button.tsx': 'shared-button\n',
  [TEMPLATE_ONLY]: 'template-widget\n',
}

function write(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content, 'utf8')
}

function makeFixture(options: { withTemplate?: boolean } = {}): Fixture {
  const withTemplate = options.withTemplate ?? true
  const base = mkdtempSync(join(tmpdir(), 'atlas-overwrite-'))
  const root = join(base, 'repo')
  const templateRoot = join(base, 'harness-templates', 'src')

  write(join(root, CUSTOM), 'project-custom\n')
  write(join(root, NAV), 'project-nav\n')
  write(join(root, UNTOUCHED), 'shared-button\n')
  write(join(root, PROJECT_ONLY), 'local-only\n')

  if (withTemplate) {
    for (const [rel, content] of Object.entries(TEMPLATE_FILES)) {
      write(join(templateRoot, rel), content)
    }
  }

  return {
    root,
    templateRoot,
    base,
    cleanup: () => rmSync(base, { recursive: true, force: true }),
  }
}

function writeRawManifest(
  root: string,
  files: Array<{ path: string; sha256: string }>,
  overrides: Record<string, unknown> = {},
): void {
  write(
    manifestPathFor(root),
    JSON.stringify(
      { version: 2, templateDir: TEMPLATE_DIR, managedCount: MANAGED_COUNT, files, ...overrides },
      null,
      2,
    ) + '\n',
  )
}

function projectHash(fixture: Fixture, path: string): string {
  return hashFile(join(fixture.root, path))
}

/** Manifesto saudável: protege só os divergentes (CUSTOM, NAV). */
function seedManifest(fixture: Fixture, paths: string[] = [CUSTOM, NAV]): void {
  writeRawManifest(
    fixture.root,
    paths.map((path) => ({ path, sha256: projectHash(fixture, path) })),
  )
}

let fixture: Fixture

beforeEach(() => {
  fixture = makeFixture()
})

afterEach(() => {
  fixture.cleanup()
})

describe('whenManifestMatchesDisk_thenCheckPasses', () => {
  it('protege só divergentes e reporta universo gerenciado', () => {
    seedManifest(fixture)

    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('ok')
    expect(report.failures).toEqual([])
    expect(report.checked).toBe(2)
    expect(report.managed).toBe(MANAGED_COUNT)
    expect(report.crossCheckAvailable).toBe(true)
    expect(formatReport(report)).toContain('2 divergentes protegidos de 3 gerenciados')
  })
})

describe('whenCustomFileChanges_thenCheckFailsWithActionableMessage', () => {
  it('aponta o arquivo e o comando de regeneração', () => {
    seedManifest(fixture)
    write(join(fixture.root, CUSTOM), 'overwritten-by-anything\n')

    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('fail')
    expect(report.failures[0]).toMatchObject({ path: CUSTOM, kind: 'hash-mismatch' })
    const text = formatReport(report)
    expect(text).toContain(CUSTOM)
    expect(text).toContain('se a mudança é legítima: npm run check:template-overrides -- --update')
  })
})

describe('whenInstallerCopiesTemplateOverNavigationFile_thenOverwriteIsDiagnosed', () => {
  it('navigation: hash divergente + idêntico ao harness-templates', () => {
    seedManifest(fixture)
    cpSync(join(fixture.templateRoot, 'components/shadcn/navigation/app-sidebar.tsx'), join(fixture.root, NAV))

    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('fail')
    expect(report.failures.map((f: { kind: string }) => f.kind).sort()).toEqual([
      'hash-mismatch',
      'template-identical',
    ])
    const text = formatReport(report)
    expect(text).toContain(NAV)
    expect(text).toContain('idêntico ao harness-templates')
    expect(text).toContain('.harness-backup/<ts>/')
  })
})

describe('whenManifestFileIsMissingOnDisk_thenCheckFails', () => {
  it('arquivo do manifesto removido é falha explícita', () => {
    seedManifest(fixture)
    rmSync(join(fixture.root, CUSTOM))

    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('fail')
    expect(report.failures.some((f: { kind: string }) => f.kind === 'missing-file')).toBe(true)
    expect(formatReport(report)).toContain('arquivo ausente')
  })
})

describe('whenManifestIsAbsent_thenCheckFailsClosed', () => {
  it('sem manifesto não há como provar integridade', () => {
    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('fail')
    expect(report.failures[0]?.kind).toBe('manifest-missing')
  })
})

describe('whenManifestIsMinimalButUseless_thenItIsRejected', () => {
  it('files:[{},{}] não devolve verde (C-1)', () => {
    writeRawManifest(fixture.root, [{}, {}] as never)

    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('fail')
    expect(report.exitCode).toBe(1)
    expect(report.failures[0]?.kind).toBe('manifest-invalid-entries')
    expect(formatReport(report)).toContain('entrada(s) inválida(s)')
  })

  it('path fora de src/ é inválido (C-1)', () => {
    writeRawManifest(fixture.root, [{ path: 'app/foo.tsx', sha256: 'a'.repeat(64) }])

    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('fail')
    expect(report.failures[0]?.kind).toBe('manifest-invalid-entries')
  })

  it('sha256 com formato inválido é recusado (C-1)', () => {
    writeRawManifest(fixture.root, [{ path: CUSTOM, sha256: 'abc' }])

    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('fail')
    expect(report.failures[0]?.kind).toBe('manifest-invalid-entries')
  })

  it('versão antiga do manifesto é recusada (C-1)', () => {
    writeRawManifest(
      fixture.root,
      [{ path: CUSTOM, sha256: projectHash(fixture, CUSTOM) }],
      { version: 1 },
    )

    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('fail')
    expect(report.failures[0]?.kind).toBe('manifest-version')
  })

  it('managedCount ausente ou incoerente falha (C-1)', () => {
    writeRawManifest(
      fixture.root,
      [{ path: CUSTOM, sha256: projectHash(fixture, CUSTOM) }],
      { managedCount: undefined },
    )
    expect(buildReport({ root: fixture.root }).failures[0]?.kind).toBe('manifest-managed-count')

    writeRawManifest(
      fixture.root,
      [{ path: CUSTOM, sha256: projectHash(fixture, CUSTOM) }],
      { managedCount: 1 },
    )
    // Internamente coerente, mas menor que o universo real (3) ⇒ denúncia de cobertura.
    expect(buildReport({ root: fixture.root }).failures[0]?.kind).toBe('managed-count-mismatch')
  })

  it('managedCount divergente do universo real é denunciado (C-1)', () => {
    writeRawManifest(
      fixture.root,
      [
        { path: CUSTOM, sha256: projectHash(fixture, CUSTOM) },
        { path: NAV, sha256: projectHash(fixture, NAV) },
      ],
      { managedCount: 9 },
    )

    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('fail')
    expect(report.failures.some((f: { kind: string }) => f.kind === 'managed-count-mismatch')).toBe(true)
  })

  it('manifesto vazio é proteção inativa', () => {
    writeRawManifest(fixture.root, [])

    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('fail')
    expect(report.failures[0]?.kind).toBe('manifest-empty')
    expect(formatReport(report)).toContain('manifesto vazio: proteção inativa')
  })
})

describe('whenTemplateDirIsMissingFromManifest_thenCheckFailsClosed', () => {
  it('sem templateDir não há comparação cruzada: falha explícita (H2)', () => {
    writeRawManifest(
      fixture.root,
      [{ path: CUSTOM, sha256: projectHash(fixture, CUSTOM) }],
      { templateDir: undefined },
    )

    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('fail')
    expect(report.failures[0]?.kind).toBe('template-dir-missing')
  })

  it('templateDir sem correspondência em src/ falha em vez de ficar inerte', () => {
    writeRawManifest(
      fixture.root,
      [{ path: CUSTOM, sha256: projectHash(fixture, CUSTOM) }],
      { templateDir: `${TEMPLATE_DIR}/components/shadcn` },
    )

    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('fail')
    expect(report.failures.some((f: { kind: string }) => f.kind === 'template-layout-mismatch')).toBe(true)
  })
})

describe('whenTemplateSiblingIsAbsent_thenCrossCheckIsSkippedAndUpdateIsFailClosed', () => {
  it('check: skip informativo, exit 0', () => {
    fixture.cleanup()
    fixture = makeFixture({ withTemplate: false })
    seedManifest(fixture)

    const report = buildReport({ root: fixture.root })

    expect(report.status).toBe('ok')
    expect(report.crossCheckAvailable).toBe(false)
    expect(report.skipped.length).toBe(1)
    expect(report.exitCode).toBe(0)
    expect(formatReport(report)).toContain('skip')
  })

  it('hash divergente NÃO sugere --update sem comparação cruzada (C-2)', () => {
    fixture.cleanup()
    fixture = makeFixture({ withTemplate: false })
    seedManifest(fixture)
    write(join(fixture.root, CUSTOM), 'overwritten-like-template\n')

    const text = formatReport(buildReport({ root: fixture.root }))

    expect(text).not.toContain('se a mudança é legítima: npm run check:template-overrides -- --update')
    expect(text).toContain('--allow-missing-template')
    expect(text).toContain('.harness-backup/<ts>/')
  })

  it('--update sem repo irmão é fail-closed (C-2)', () => {
    fixture.cleanup()
    fixture = makeFixture({ withTemplate: false })
    seedManifest(fixture)

    expect(() => updateManifest({ root: fixture.root })).toThrow(/repo irmão ausente/)
  })

  it('--allow-missing-template é o escape explícito (C-2)', () => {
    fixture.cleanup()
    fixture = makeFixture({ withTemplate: false })
    seedManifest(fixture)
    write(join(fixture.root, CUSTOM), 'template-body\n') // conteúdo de template, sem repo para provar

    const text = updateManifest({ root: fixture.root, allowMissingTemplate: true })
    const onDisk = JSON.parse(text) as { files: Array<{ path: string; sha256: string }> }

    expect(onDisk.files.find((f) => f.path === CUSTOM)?.sha256).toBe(
      hashFile(join(fixture.root, CUSTOM)),
    )
  })
})

describe('whenManagedFilesAreNotInManifest_thenAuditFails', () => {
  it('divergente fora do manifesto é denunciado no check e no audit (A-6)', () => {
    seedManifest(fixture, [CUSTOM])

    const report = buildReport({ root: fixture.root })
    expect(report.status).toBe('fail')
    expect(
      report.failures.filter((f: { kind: string }) => f.kind === 'unmanaged-file').map((f: { path: string }) => f.path),
    ).toEqual([NAV])

    const audit = formatAudit({ root: fixture.root })
    expect(audit.exitCode).toBe(1)
    expect(audit.missing).toEqual([NAV])
    expect(audit.lines.join('\n')).toContain('divergentes fora do manifesto (1)')
  })

  it('audit verde quando todos os divergentes estão registrados (arquivo idêntico não é exigido)', () => {
    seedManifest(fixture)

    const audit = formatAudit({ root: fixture.root })

    expect(audit.exitCode).toBe(0)
    expect(audit.missing).toEqual([])
    expect(audit.lines.join('\n')).toContain('nenhum divergente fora do manifesto')
  })

  it('audit falha com templateDir ausente (mesmo veredito do check) (A-6)', () => {
    writeRawManifest(
      fixture.root,
      [{ path: CUSTOM, sha256: projectHash(fixture, CUSTOM) }],
      { templateDir: undefined },
    )

    const audit = formatAudit({ root: fixture.root })

    expect(audit.exitCode).toBe(1)
    expect(audit.lines.join('\n')).toContain('templateDir ausente')
  })

  it('audit falha com templateDir sem correspondência (A-6)', () => {
    writeRawManifest(
      fixture.root,
      [{ path: CUSTOM, sha256: projectHash(fixture, CUSTOM) }],
      { templateDir: `${TEMPLATE_DIR}/components/shadcn` },
    )

    const audit = formatAudit({ root: fixture.root })

    expect(audit.exitCode).toBe(1)
    expect(audit.lines.join('\n')).toContain('sem correspondência')
  })

  it('audit só é skip quando o repo irmão não existe (A-6)', () => {
    fixture.cleanup()
    fixture = makeFixture({ withTemplate: false })
    seedManifest(fixture)

    const audit = formatAudit({ root: fixture.root })

    expect(audit.exitCode).toBe(0)
    expect(audit.lines.join('\n')).toContain('audit skip')
  })
})

describe('whenListingFiles_thenManagedIsIntersectionAndDivergentIsTheProtectedSet', () => {
  it('managed: só arquivos presentes nos dois lados, ordenados', () => {
    const managed = listManagedFiles({ root: fixture.root, templateDir: TEMPLATE_DIR })

    expect(managed).toEqual([CUSTOM, NAV, UNTOUCHED])
    expect(managed).not.toContain(PROJECT_ONLY)
    expect(managed.some((path: string) => path.includes('new-widget'))).toBe(false)
  })

  it('divergentes excluem o arquivo idêntico ao template (A-1)', () => {
    expect(listDivergentFiles({ root: fixture.root, templateDir: TEMPLATE_DIR })).toEqual([CUSTOM, NAV])
  })

  it('sem repo irmão não há gerenciados nem divergentes', () => {
    fixture.cleanup()
    fixture = makeFixture({ withTemplate: false })

    expect(listManagedFiles({ root: fixture.root, templateDir: TEMPLATE_DIR })).toEqual([])
    expect(listDivergentFiles({ root: fixture.root, templateDir: TEMPLATE_DIR })).toEqual([])
  })
})

describe('whenReportIsFormatted_thenOutputIsDeterministic', () => {
  it('mesma entrada ⇒ mesma saída, sem timestamp e em ordem estável', () => {
    seedManifest(fixture)
    write(join(fixture.root, NAV), 'changed-nav\n')
    write(join(fixture.root, CUSTOM), 'changed-custom\n')

    const first = formatReport(buildReport({ root: fixture.root }))
    const second = formatReport(buildReport({ root: fixture.root }))

    expect(first).toBe(second)
    expect(first).not.toMatch(/\d{2}:\d{2}:\d{2}/)
    expect(first).not.toMatch(/20\d{2}-\d{2}-\d{2}T/)
    expect(first.indexOf(CUSTOM)).toBeLessThan(first.indexOf(NAV))
  })
})

describe('whenUpdateIsRequested_thenManifestIsRewrittenFromTheProject', () => {
  it('grava hashes do projeto, só divergentes, com managedCount (A-1)', () => {
    writeRawManifest(fixture.root, [
      { path: CUSTOM, sha256: '0'.repeat(64) },
      { path: NAV, sha256: '1'.repeat(64) },
    ])

    const text = updateManifest({ root: fixture.root })
    const onDisk = readManifest(fixture.root)

    expect(onDisk.files.map((f: { path: string }) => f.path)).toEqual([CUSTOM, NAV])
    expect(onDisk.managedCount).toBe(MANAGED_COUNT)
    expect(onDisk.files[0]?.sha256).toBe(projectHash(fixture, CUSTOM))
    expect(readFileSync(manifestPathFor(fixture.root), 'utf8')).toBe(text)
    expect(text.endsWith('\n')).toBe(true)
    expect(buildReport({ root: fixture.root }).status).toBe('ok')
  })

  it('adiciona arquivo que passou a divergir e remove o que voltou a ser idêntico (A-1)', () => {
    writeRawManifest(fixture.root, [
      { path: CUSTOM, sha256: projectHash(fixture, CUSTOM) },
      { path: UNTOUCHED, sha256: hashFile(join(fixture.templateRoot, 'components/shadcn/ui/button.tsx')) },
    ])
    write(join(fixture.root, UNTOUCHED), 'project-button-customized\n')

    updateManifest({ root: fixture.root })
    const onDisk = readManifest(fixture.root)

    expect(onDisk.files.map((f: { path: string }) => f.path)).toEqual([CUSTOM, NAV, UNTOUCHED])
    expect(formatAudit({ root: fixture.root }).exitCode).toBe(0)
  })

  it('remove do manifesto entrada que não diverge mais (volta a ser igual ao template)', () => {
    seedManifest(fixture, [CUSTOM, NAV, UNTOUCHED])
    // UNTOUCHED está registrado com o próprio hash (== template): entrada inútil.
    const before = readManifest(fixture.root)
    expect(before.files.map((f: { path: string }) => f.path)).toContain(UNTOUCHED)

    updateManifest({ root: fixture.root })
    const after = readManifest(fixture.root)

    expect(after.files.map((f: { path: string }) => f.path)).toEqual([CUSTOM, NAV])
  })

  it('remove do manifesto entradas que não são gerenciadas', () => {
    writeRawManifest(fixture.root, [
      { path: CUSTOM, sha256: projectHash(fixture, CUSTOM) },
      { path: PROJECT_ONLY, sha256: projectHash(fixture, PROJECT_ONLY) },
    ])

    updateManifest({ root: fixture.root })

    const onDisk = readManifest(fixture.root)
    expect(onDisk.files.some((f: { path: string }) => f.path === PROJECT_ONLY)).toBe(false)
  })

  it('recusa legitimar overwrite e mantém a entrada para o erro persistir (C-2/H3)', () => {
    seedManifest(fixture)
    cpSync(join(fixture.templateRoot, 'components/shadcn/navigation/app-sidebar.tsx'), join(fixture.root, NAV))

    expect(() => updateManifest({ root: fixture.root })).toThrow(/idêntico ao harness-templates/)
    expect(readManifest(fixture.root).files.map((f: { path: string }) => f.path)).toContain(NAV)
  })

  it('escape explícito permite gravar com justificativa', () => {
    seedManifest(fixture)
    cpSync(join(fixture.templateRoot, 'components/shadcn/navigation/app-sidebar.tsx'), join(fixture.root, NAV))

    const text = updateManifest({ root: fixture.root, allowTemplateIdentical: true })
    const onDisk = JSON.parse(text) as { files: Array<{ path: string; sha256: string }> }

    expect(onDisk.files.find((f) => f.path === NAV)?.sha256).toBe(projectHash(fixture, NAV))
  })

  it('arquivo nunca customizado (idêntico ao template) não entra no manifesto', () => {
    writeRawManifest(fixture.root, [{ path: CUSTOM, sha256: projectHash(fixture, CUSTOM) }])

    updateManifest({ root: fixture.root })
    const onDisk = readManifest(fixture.root)

    expect(onDisk.files.map((f: { path: string }) => f.path)).not.toContain(UNTOUCHED)
  })

  it('update recusa arquivo ausente em vez de mascarar', () => {
    seedManifest(fixture)
    rmSync(join(fixture.root, CUSTOM))

    expect(() => updateManifest({ root: fixture.root })).toThrow(/arquivo ausente/)
  })
})
