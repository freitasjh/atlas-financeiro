import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * AUTH-12 / RF-11 / F-1 — prova de fronteira sem green-falso.
 *
 * Base da fatia = HEAD (9e35751), conforme PRD. Todo trabalho ADR-001 vive no
 * working tree; `develop` é anterior aos merges de nestjs-modular-split e
 * frontend-migracao, então `develop..HEAD` mede a base herdada, não a fatia.
 *
 * Nenhuma fixture é gravada em disco: PEM/path proibido/JWT são strings em
 * memória. Nenhum valor de .env é lido ou impresso — só a saída REDACTED do
 * scan-secrets oficial é interpretada.
 */
const HERE = __dirname;
const ROOT = resolve(HERE, '../../../..');
const BACKEND_ROOT = join(ROOT, 'backend');
const GOLDEN_FILE = join(HERE, 'golden/auth-before.fixture.json');
/** O verificador contém os padrões proibidos como literais — não é alvo de si mesmo. */
const SELF_PATH = join(HERE, 'auth-slice-boundary.spec.ts').slice(ROOT.length + 1);

/** Único artefato de assinatura humana (AUTH-01); qualquer outro `.doc/**` segue barrado. */
const SIGNATURE_ARTIFACT = '.doc/aprovacoes/auth-golden-2026-11-25.md';

/** ADR-001 §3 "Portas, comandos, fronteira de arquivos" + apoio de testes/DDL. */
const ALLOWED_CODE_ROOTS = [
  'backend/apps/cliente/',
  'backend/libs/shared-contracts/src/v1/',
  'backend/migrations/',
  'frontend/src/',
  'frontend/docs/',
  'frontend/tests/',
];

const ALLOWED_PORTS = new Set(['3001', '3002', '5173']);
type Finding = { path: string; line: number; patternId: string };
type ScanReport = {
  limpo: { count: number; findings: Finding[] };
  ignorado: { count: number; findings: Finding[] };
  summary: { count: number; trackedFiles: number; globFiles: number };
};

function gitLines(args: string[]): string[] {
  const run = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`git ${args.join(' ')} falhou (status ${run.status})`);
  return (run.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

/** HEAD no diff pega também edição staged — não só worktree vs índice. */
function protectedPathsDiffArgs(): string[] {
  return ['diff', 'HEAD', '--exit-code', '--', 'scripts/scan-secrets.mjs', 'harness.config.json'];
}

const isCodePath = (path: string): boolean => /^(backend|frontend)\//.test(path);
const isHarnessPath = (path: string): boolean =>
  path.startsWith('.agents/') ||
  path === 'workflow-state.json' ||
  path === 'tsconfig.tsbuildinfo' ||
  path.startsWith('supabase/.temp/') ||
  path === 'nohup.out';

/** Puro: plantio em memória, sem gravar fixture em disco. */
function unexpectedPathsFrom(all: string[]): string[] {
  return all.filter(
    (path) => !isCodePath(path) && !isHarnessPath(path) && path !== SIGNATURE_ARTIFACT,
  );
}

/** Slice ADR-001 = working tree vs HEAD (base 9e35751). */
function collectSlicePaths(): {
  codePaths: string[];
  harnessPaths: string[];
  unexpectedPaths: string[];
} {
  const all = [...new Set([
    ...gitLines(['diff', 'HEAD', '--name-only']),
    ...gitLines(['ls-files', '--others', '--exclude-standard']),
  ])];
  return {
    codePaths: all.filter(isCodePath),
    harnessPaths: all.filter(isHarnessPath),
    unexpectedPaths: unexpectedPathsFrom(all),
  };
}

function boundaryViolations(paths: string[]): Array<{ path: string; reason: string }> {
  const rules = [
    {
      test: (path: string) => path.startsWith('backend/apps/control-plane/'),
      reason: 'control-plane fora da fatia ADR-001',
    },
    {
      test: (path: string) => path === 'harness.config.json' || path === 'gate.js' || path.endsWith('/gate.js'),
      reason: 'harness/gate intacto',
    },
    {
      test: (path: string) =>
        path.startsWith('scripts/') ||
        path.startsWith('.opencode/') ||
        path === 'opencode.json' ||
        path.startsWith('.spec/') ||
        path.startsWith('.agents/'),
      reason: 'protected path / scripts fora da fatia',
    },
    {
      test: (path: string) => !ALLOWED_CODE_ROOTS.some((root) => path.startsWith(root)),
      reason: 'path fora dos paths ADR-001 §3',
    },
  ];
  const violations: Array<{ path: string; reason: string }> = [];
  for (const path of paths) {
    for (const rule of rules) {
      if (rule.test(path)) violations.push({ path, reason: rule.reason });
    }
  }
  return violations;
}

// Termos montados em partes: o verificador não pode conter os literais que caça
// (G1 varre todo apps/** e reprovaria as próprias fixtures).
const term = (parts: string[]) => parts.join('');
const providerTerms = [
  term(['asa', 'as']),
  term(['webhook.?', 'ps', 'p']),
  term(['check', 'out']),
  term(['paga', 'mento']),
  term(['pay', 'ment']),
  term(['cobra', 'nca']),
];
// Backend: qualquer módulo financeiro é fora da fatia. Frontend: catálogos
// i18n já trazem esses rótulos como UI; só provedor externo é novo.
const forbiddenBackend = new RegExp(`\\b(?:${providerTerms.join('|')})\\b`, 'i');
const forbiddenFrontend = new RegExp(`(?:${providerTerms[0]}|${providerTerms[1]}|\\b${term(['ps', 'p'])}\\b)`, 'i');
const dbEnv = ['DATABASE', '_URL'].join('');
const portLiteral = /\b(?:PORT|port|listen)\D{0,16}(\d{4,5})\b/g;

/** Matcher puro: a ramificação é a única diferença entre backend e frontend. */
function findForbiddenTerms(text: string, backend: boolean): boolean {
  return (backend ? forbiddenBackend : forbiddenFrontend).test(String(text));
}

function contentViolations(paths: string[]): Array<{ path: string; reason: string }> {
  const violations: Array<{ path: string; reason: string }> = [];
  for (const path of paths) {
    if (path === SELF_PATH) continue;
    let text: string;
    try {
      text = readFileSync(join(ROOT, path), 'utf8');
    } catch {
      continue;
    }
    if (findForbiddenTerms(text, path.startsWith('backend/'))) {
      violations.push({ path, reason: 'modulo de provedor proibido' });
    }
    for (const match of text.matchAll(new RegExp(`\\b${dbEnv}\\b`, 'g'))) {
      const before = text.slice(Math.max(0, (match.index ?? 0) - 13), match.index ?? 0);
      if (!/(?:CLIENTE_|CONTROL_PLANE_)$/.test(before)) {
        violations.push({ path, reason: 'env de banco generico proibido' });
      }
    }
    for (const match of text.matchAll(portLiteral)) {
      if (!ALLOWED_PORTS.has(match[1])) violations.push({ path, reason: `porta nova ${match[1]}` });
    }
  }
  return violations;
}

/** Matcher puro RF-14: RSA/EC/OPENSSH/DSA e PEM sem tipo, fora placeholder. */
function hasPemHeader(text: string): boolean {
  return /BEGIN (?:EC |RSA |OPENSSH |DSA )?PRIVATE KEY/.test(String(text));
}

function findPemHits(text: string): string[] {
  return [...String(text).matchAll(/BEGIN (?:EC |RSA |OPENSSH |DSA )?PRIVATE KEY/g)].map((hit) => hit[0]);
}

/** Token JWT de 3 segmentos; placeholder não conta como segredo real. */
function hasRealJwt(text: string): boolean {
  return /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/.test(String(text));
}

function scanBackendPem(): Array<{ path: string; line: number }> {
  const skippedDirs = new Set(['node_modules', 'dist', '.git', '.vite', 'coverage']);
  const hits: Array<{ path: string; line: number }> = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!skippedDirs.has(entry.name)) walk(absolute);
        continue;
      }
      let text: string;
      try {
        text = readFileSync(absolute, 'utf8');
      } catch {
        continue;
      }
      text.split(/\r?\n/).forEach((line, index) => {
        if (hasPemHeader(line)) {
          hits.push({ path: `backend/${absolute.slice(BACKEND_ROOT.length + 1)}`, line: index + 1 });
        }
      });
    }
  };
  walk(BACKEND_ROOT);
  return hits;
}

function isAllowedSentinel(value: string): boolean {
  // Espelha ALLOWED_FORMS de scripts/scan-secrets.mjs:11-16.
  return /^<PLACEHOLDER_[A-Z_]+>$/.test(String(value).trim());
}

function parseScanOutput(stdout: string): {
  tracked: Finding[];
  ignored: Finding[];
  summary: { count: number; trackedFiles: number; globFiles: number };
} {
  const tracked: Finding[] = [];
  const ignored: Finding[] = [];
  let summary = { count: -1, trackedFiles: -1, globFiles: -1 };
  const findingLine = /^(\S+):(\d+) (\S+) REDACTED(?: ignored:(true|false))?$/;
  const summaryLine = /^scan-secrets: (\d+) achado\(s\); arquivos rastreados=(\d+), glob=(\d+)$/;
  for (const raw of String(stdout).split(/\r?\n/)) {
    const line = raw.trim();
    const finding = line.match(findingLine);
    if (finding) {
      const item: Finding = { path: finding[1], line: Number(finding[2]), patternId: finding[3] };
      // Falso ou ausente ⇒ rastreado (fail-closed); só `true` vai à seção separada.
      (finding[4] === 'true' ? ignored : tracked).push(item);
      continue;
    }
    const total = line.match(summaryLine);
    if (total) {
      summary = { count: Number(total[1]), trackedFiles: Number(total[2]), globFiles: Number(total[3]) };
    }
  }
  return { tracked, ignored, summary };
}

function buildSecretReport(parsed: ReturnType<typeof parseScanOutput>): ScanReport {
  return {
    limpo: { count: parsed.tracked.length, findings: parsed.tracked },
    ignorado: { count: parsed.ignored.length, findings: parsed.ignored },
    summary: parsed.summary,
  };
}

describe('AUTH-12 — fronteira de diff, harness intacto, zero segredo/provedor proibido', () => {
  it('whenBranchDiffScanned_thenOnlyAllowedPaths', () => {
    const slice = collectSlicePaths();
    expect(slice.codePaths.length).toBeGreaterThan(0);
    expect(slice.unexpectedPaths).toEqual([]);
    expect(boundaryViolations(slice.codePaths)).toEqual([]);
    expect(contentViolations(slice.codePaths)).toEqual([]);

    // Achados de harness/sessão são listados, nunca chamados de "limpo".
    expect(slice.harnessPaths.length).toBeGreaterThan(0);

    const intact = spawnSync('git', protectedPathsDiffArgs(), { cwd: ROOT, encoding: 'utf8' });
    expect(intact.error).toBeUndefined();
    expect(intact.status).toBe(0);
  });

  it('whenSignatureArtifactPresent_thenAllowed', () => {
    const planted = [
      'backend/apps/cliente/src/auth/public-auth.controller.ts',
      SIGNATURE_ARTIFACT,
    ];

    expect(unexpectedPathsFrom(planted)).toEqual([]);
  });

  it('whenOtherDocPathPresent_thenBlocked', () => {
    const planted = [
      'backend/apps/cliente/src/auth/public-auth.controller.ts',
      '.doc/aprovacoes/outro-artefato.md',
      '.doc/privado/rascunho.md',
      SIGNATURE_ARTIFACT,
    ];

    expect(unexpectedPathsFrom(planted)).toEqual([
      '.doc/aprovacoes/outro-artefato.md',
      '.doc/privado/rascunho.md',
    ]);
  });

  it('whenControlPlaneTouched_thenFails', () => {
    const fixture = [
      'backend/apps/cliente/src/auth/public-auth.controller.ts',
      'backend/apps/control-plane/src/app.module.ts',
      'frontend/src/session/session.ts',
    ];
    const violations = boundaryViolations(fixture);

    expect(violations.map((item) => item.path)).toContain('backend/apps/control-plane/src/app.module.ts');
    expect(violations.some((item) => item.reason.includes('control-plane'))).toBe(true);
    expect(boundaryViolations(collectSlicePaths().codePaths)).toEqual([]);
  });

  it('whenBackendHasPrivateKeyPem_thenFails', () => {
    // Montado em runtime: nenhum header literal vive dentro de backend/**.
    const pemHeader = (type: string) => ['-----BEGIN ', type, 'PRIVATE KEY-----'].join('');
    const fixtures = ['RSA ', 'EC ', 'OPENSSH ', 'DSA ', ''].map(pemHeader);
    for (const fixture of fixtures) {
      expect(findPemHits(fixture).length, fixture).toBeGreaterThan(0);
    }
    expect(findPemHits('-----BEGIN PUBLIC KEY-----')).toEqual([]);
    expect(findPemHits('<PLACEHOLDER_TOKEN>')).toEqual([]);
    expect(scanBackendPem()).toEqual([]);
  });

  it('whenGoldenUsesPlaceholderSentinel_thenAllowed', () => {
    const text = readFileSync(GOLDEN_FILE, 'utf8');
    const fragment = (parts: string[]) => parts.join('');
    const syntheticToken = fragment(['eyJ', 'hbGciOiJFUzI1NiJ9.', 'eyJzdWIiOiJ4In0.', 'c2lnbmF0dXJlZmFrZQ']);

    expect(text).toContain('<PLACEHOLDER_TOKEN>');
    expect(isAllowedSentinel('<PLACEHOLDER_TOKEN>')).toBe(true);
    expect(hasRealJwt(syntheticToken)).toBe(true);
    expect(isAllowedSentinel(syntheticToken)).toBe(false);
    expect(hasRealJwt(text)).toBe(false);
    expect(findPemHits(text)).toEqual([]);
  });

  it('whenEnvFindingsIgnored_thenReportedSeparately', () => {
    const run = spawnSync('node', [join(ROOT, 'scripts/scan-secrets.mjs')], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    expect(run.error).toBeUndefined();

    const report: ScanReport = buildSecretReport(parseScanOutput(run.stdout ?? ''));
    expect(report.limpo.count).toBe(0);
    expect(report.ignorado.count).toBeGreaterThan(0);
    expect(report.ignorado.findings.every((item) => /(^|\/)\.env(\.local)?$/.test(item.path))).toBe(true);
    expect(report.ignorado.findings.every((item) => Object.keys(item).sort().join(',') === 'line,path,patternId')).toBe(true);
    expect(report.summary.count).toBe(report.limpo.count + report.ignorado.count);
    expect(report.summary.count).toBeGreaterThan(0);
    // Achado ignorado existe: o scanner não pode ser lido como "limpo".
    expect(run.status).not.toBe(0);
  });

  it('whenIgnoredFalseSuffixParsed_thenFindingIsTracked', () => {
    const parsed = parseScanOutput([
      'x.ts:1 jwt REDACTED ignored:false',
      '.env:9 entropy REDACTED ignored:true',
    ].join('\n'));

    expect(parsed.tracked.map((item) => item.patternId)).toEqual(['jwt']);
    expect(parsed.ignored.map((item) => item.patternId)).toEqual(['entropy']);
    expect(buildSecretReport(parsed).limpo.count).toBe(1);
  });

  it('whenProtectedDiffUsesHead_thenStagedEditsAreInScope', () => {
    const args = protectedPathsDiffArgs();

    expect(args.slice(0, 3)).toEqual(['diff', 'HEAD', '--exit-code']);
    expect(args).toContain('scripts/scan-secrets.mjs');
    expect(args).toContain('harness.config.json');
  });

  it('whenPositiveControlsPlanted_thenPureMatchersReject', () => {
    const fragment = (parts: string[]) => parts.join('');
    const neutral = 'session refresh token context';

    expect(findForbiddenTerms(fragment(['asa', 'as']), true)).toBe(true);
    expect(findForbiddenTerms(fragment(['asa', 'as']), false)).toBe(true);
    expect(findForbiddenTerms(fragment(['webhook.', 'ps', 'p']), false)).toBe(true);
    expect(findForbiddenTerms(fragment(['check', 'out']), true)).toBe(true);
    expect(findForbiddenTerms(fragment(['check', 'out']), false)).toBe(false);
    expect(findForbiddenTerms(neutral, true)).toBe(false);
    expect(findForbiddenTerms(neutral, false)).toBe(false);

    expect(hasPemHeader(fragment(['-----BEGIN ', 'RSA ', 'PRIVATE KEY-----']))).toBe(true);
    expect(hasPemHeader(neutral)).toBe(false);

    const jwt = fragment(['eyJ', 'hbGciOiJFUzI1NiJ9.', 'eyJzdWIiOiJ4In0.', 'c2lnbmF0dXJlZmFrZQ']);
    expect(hasRealJwt(jwt)).toBe(true);
    expect(hasRealJwt('<PLACEHOLDER_TOKEN>')).toBe(false);
  });
});
