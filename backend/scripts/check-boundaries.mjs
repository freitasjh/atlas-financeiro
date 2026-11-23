#!/usr/bin/env node
/**
 * G1 — gate autoritativo de fronteiras (ADR-001 §6 item 6 / SPEC §9.6).
 * Varre specifiers estáticos, re-exports, imports dinâmicos, require() e texto
 * proibido em apps/**, libs/** e arquivos soltos na raiz. Sem dependência nova.
 * Exit != 0 com arquivo, specifier e regra nomeados. G2 (ESLint
 * no-restricted-imports) é complementar.
 */
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = path.resolve(HERE, '..');
const rootIndex = process.argv.indexOf('--root');
const ROOT = rootIndex >= 0 ? path.resolve(process.argv[rootIndex + 1]) : DEFAULT_ROOT;

const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'coverage', 'scripts']);
const violations = [];
let scanned = 0;

function walk(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walk(full);
      continue;
    }
    if (!EXTENSIONS.has(path.extname(entry.name))) continue;
    scanned += 1;
    inspect(path.relative(ROOT, full).split(path.sep).join('/'), full);
  }
}

/** Arquivos soltos na raiz (ex.: bridge.ts) também são código do workspace. */
function walkRootFiles(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) continue;
    if (!EXTENSIONS.has(path.extname(entry.name))) continue;
    scanned += 1;
    inspect(entry.name, path.join(directory, entry.name));
  }
}

function stripComments(raw) {
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1 ');
}

function contextOf(relativePath) {
  if (relativePath.startsWith('apps/cliente/')) return 'cliente';
  if (relativePath.startsWith('apps/control-plane/')) return 'control-plane';
  if (relativePath.startsWith('libs/')) return 'shared';
  if (!relativePath.includes('/')) return 'raiz';
  return 'other';
}

/** Detecta o app alvo em specifiers diretos, aliases e caminhos relativos já resolvidos. */
function targetApp(value) {
  const direct = value.match(/(?:^|\/)apps\/(cliente|control-plane)(?:\/|$)/);
  if (direct) return direct[1];
  const alias = value.match(/^@(?:app\/)?(cliente|control-plane)(?:\/|$)/);
  return alias ? alias[1] : null;
}

function add(rule, file, message, specifier) {
  violations.push({ rule, file, message, specifier });
}

function specifiers(code) {
  const found = [];
  const patterns = [
    { regex: /\bimport\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?['"]([^'"]+)['"]/g, kind: 'import' },
    { regex: /\bexport\s+(?:type\s+)?[\s\S]*?\s+from\s+['"]([^'"]+)['"]/g, kind: 'reexport' },
    { regex: /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'dynamic-import' },
    { regex: /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g, kind: 'require' },
  ];
  for (const { regex, kind } of patterns) {
    for (const match of code.matchAll(regex)) {
      found.push({ value: match[1], kind });
    }
  }
  return found;
}

function inspect(relativePath, absolutePath) {
  const raw = readFileSync(absolutePath, 'utf8');
  const code = stripComments(raw);
  const context = contextOf(relativePath);

  const forbiddenTarget =
    context === 'cliente'
      ? 'control-plane'
      : context === 'control-plane'
        ? 'cliente'
        : context === 'shared' || context === 'raiz'
          ? 'any'
          : null;

  for (const { value, kind } of specifiers(code)) {
    let target = targetApp(value);
    if (!target && value.startsWith('.')) {
      const resolved = path
        .relative(ROOT, path.resolve(path.dirname(absolutePath), value))
        .split(path.sep)
        .join('/');
      const resolvedMatch = resolved.match(/^apps\/(cliente|control-plane)(?:\/|$)/);
      if (resolvedMatch) target = resolvedMatch[1];
    }

    if (
      target &&
      forbiddenTarget &&
      (forbiddenTarget === 'any' || target === forbiddenTarget)
    ) {
      add(
        'cross-context',
        relativePath,
        `specifier '${value}' (${kind}) cruza a fronteira ${context} → apps/${target}`,
        value,
      );
    }
  }

  if (/@Global\s*\(\s*\)/.test(raw)) {
    add('@Global()', relativePath, 'decorador @Global() proibido: API pública só por exports', '@Global()');
  }

  const paymentMatch = raw.match(
    /\b(asaas-webhook|asaas|pagamento|payment|checkout|cobranca|webhook.?psp|\bpsp\b)/i,
  );
  if (paymentMatch) {
    add(
      'modulo-proibido',
      relativePath,
      `módulo de pagamento/PSP proibido no beta: ${paymentMatch[0]}`,
      paymentMatch[0],
    );
  }

  const messagingMatch = raw.match(/@MessagePattern|ClientProxy|@nestjs\/microservices|\boutbox\b/i);
  if (messagingMatch) {
    add(
      'modulo-proibido',
      relativePath,
      `transporte de mensageria/outbox proibido nesta fatia: ${messagingMatch[0]}`,
      messagingMatch[0],
    );
  }

  for (const match of raw.matchAll(/\bDATABASE_URL\b/g)) {
    const before = raw.slice(Math.max(0, match.index - 13), match.index);
    if (/(?:CLIENTE_|CONTROL_PLANE_)$/.test(before)) continue;
    add('env-proibido', relativePath, 'DATABASE_URL genérico proibido; use CLIENTE_/CONTROL_PLANE_', 'DATABASE_URL');
  }

  const secretMatch = raw.match(
    /['"](?:postgres(?:ql)?|mysql):\/\/[^'"]*['"]|\b(?:sk_live_|sk_test_|ghp_|AKIA)[A-Za-z0-9]{12,}|\b(?:secret|password|apiKey|jwt_secret)\b\s*[:=]\s*['"][^'"]{16,}['"]/i,
  );
  if (secretMatch) {
    add(
      'segredo-versionado',
      relativePath,
      `URL de banco ou segredo literal versionado: ${secretMatch[0].slice(0, 24)}…`,
      'literal-secret',
    );
  }

  const providerMatch = context === 'shared'
    ? raw.match(/DrizzleModule|@Entity|\bRepository\b/)
    : null;
  if (providerMatch) {
    add(
      'lib-provider',
      relativePath,
      `shared-contracts só contém formas de dados: ${providerMatch[0]}`,
      providerMatch[0],
    );
  }
}

walk(path.join(ROOT, 'apps'));
walk(path.join(ROOT, 'libs'));
walkRootFiles(ROOT);

if (violations.length > 0) {
  for (const item of violations) {
    process.stderr.write(
      `G1 ${item.rule} ${item.file} [${item.specifier}] — ${item.message}\n`,
    );
  }
  process.stderr.write(
    `G1 FALHOU: ${violations.length} violação(ões) em ${scanned} arquivo(s) varrido(s).\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `[G1] varredura: ${scanned} arquivo(s) em apps/, libs/ e raiz/\n` +
      '[G1] 0 cruzados, 0 módulos proibidos, 0 env proibido, 0 segredo versionado — OK\n' +
      '[G1] gate autoritativo (G2/ESLint no-restricted-imports é complementar via test:gate)\n',
  );
}
