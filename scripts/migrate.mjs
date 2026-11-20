#!/usr/bin/env node
// Migra/instala o Harness de Frontend (perfil shadcn|claude) em um projeto existente.
// Uso: node scripts/migrate.mjs --target <dir> [--profile shadcn|claude] [--brand Nome] [--force] [--no-validate]
// - Copia/atualiza arquivos do template (com backup em .harness-backup/<timestamp>).
// - Mescla package.json (scripts) e opencode.jsonc (MCP storybook).
// - Roda validação ao final (a menos que --no-validate).
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, copyFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync, spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const harnessRoot = resolve(here, "..");

function arg(name, fallback) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

const targetArg = arg("target", ".");
const profile = arg("profile", "shadcn");
const brand = arg("brand");
const force = hasFlag("force");
const noValidate = hasFlag("no-validate");

if (!["shadcn", "claude"].includes(profile)) {
  console.error(`perfil inválido: ${profile} (use shadcn ou claude)`);
  process.exit(1);
}
const target = resolve(targetArg);
const pkgPath = join(target, "package.json");
if (!existsSync(pkgPath)) {
  console.error(`sem package.json em ${target}`);
  process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupRoot = join(target, ".harness-backup", timestamp);
let backedUp = 0;
const created = [];
const updated = [];
const skipped = [];

function backup(absPath) {
  if (!existsSync(absPath)) return;
  const rel = relative(target, absPath);
  const dst = join(backupRoot, rel);
  mkdirSync(dirname(dst), { recursive: true });
  const st = statSync(absPath);
  if (st.isDirectory()) cpSync(absPath, dst, { recursive: true });
  else copyFileSync(absPath, dst);
  backedUp++;
}

function writeFile(relPath, content) {
  const abs = join(target, relPath);
  if (existsSync(abs)) {
    backup(abs);
    updated.push(relPath);
  } else {
    created.push(relPath);
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

function copyFileRel(relPath) {
  const src = join(harnessRoot, relPath);
  const dst = join(target, relPath);
  if (!existsSync(src)) return;
  if (existsSync(dst) && !force) {
    // still update template-owned files by default (migration); use skip only for tokens if desired
  }
  if (existsSync(dst)) backup(dst);
  else created.push(relPath);
  if (existsSync(dst)) updated.push(relPath);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
}

function copyTreeRel(relDir) {
  const srcDir = join(harnessRoot, relDir);
  if (!existsSync(srcDir)) return;
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const src = join(dir, name);
      const st = statSync(src);
      const rel = relative(harnessRoot, src);
      if (st.isDirectory()) walk(src);
      else copyFileRel(rel);
    }
  };
  walk(srcDir);
}

// ---- arquivos do template a migrar ----
const templateFiles = [
  "scripts/build-tokens.mjs",
  "scripts/verify.sh",
  "scripts/init.mjs",
  "scripts/migrate.mjs",
  "scripts/validate.mjs",
  ".oxlintrc.json",
  "components.json",
];
for (const f of templateFiles) {
  if (existsSync(join(harnessRoot, f))) copyFileRel(f);
}

// tokens do perfil (sempre atualiza com backup)
const profileTokensDir = join(harnessRoot, "profiles", profile, "tokens");
for (const name of ["base.json", "semantic.json"]) {
  const src = join(profileTokensDir, name);
  if (existsSync(src)) {
    const rel = `tokens/${name}`;
    if (existsSync(join(target, rel))) backup(join(target, rel));
    else created.push(rel);
    if (existsSync(join(target, rel))) updated.push(rel);
    mkdirSync(join(target, "tokens"), { recursive: true });
    copyFileSync(src, join(target, rel));
  }
}
const themesSrc = join(profileTokensDir, "themes");
// copy themes into tokens/themes
if (existsSync(themesSrc)) {
  for (const name of readdirSync(themesSrc)) {
    const src = join(themesSrc, name);
    const rel = `tokens/themes/${name}`;
    const dst = join(target, rel);
    if (existsSync(dst)) backup(dst);
    else created.push(rel);
    if (existsSync(dst)) updated.push(rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

// ---- DESIGN.md do perfil (adaptado ao profile decidido) ----
const designSrc = join(harnessRoot, "profiles", profile, "DESIGN.md");
if (existsSync(designSrc)) {
  const rel = "DESIGN.md";
  const dst = join(target, rel);
  if (existsSync(dst)) backup(dst);
  else created.push(rel);
  if (existsSync(dst)) updated.push(rel);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(designSrc, dst);
}

// ---- Storybook (gerado conforme framework do projeto, não copiado do harness) ----
const migratePkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const migrateDeps = { ...(migratePkg.dependencies ?? {}), ...(migratePkg.devDependencies ?? {}) };
const isNextMig = Boolean(migrateDeps.next);
const frameworkMig = isNextMig ? "@storybook/nextjs" : "@storybook/react-vite";
const sbMain = `import type { StorybookConfig } from "${frameworkMig}";

const config: StorybookConfig = {
  framework: "${frameworkMig}",
  stories: ["../src/**/*.stories.@(ts|tsx)", "../src/**/*.mdx"],
  addons: ["@storybook/addon-a11y", "@storybook/addon-mcp"],
  features: { componentsManifest: true },
};

export default config;
`;
writeFile(".storybook/main.ts", sbMain);
const sbCssImports = [
  'import "../src/tokens-generated.css";',
  existsSync(join(target, "src", "index.css")) ? 'import "../src/index.css";' : null,
  isNextMig && existsSync(join(target, "src", "app", "globals.css")) ? 'import "../src/app/globals.css";' : null,
].filter(Boolean);
const sbPreview = `${sbCssImports.join("\n")}

import type { Preview } from "${frameworkMig}";

const preview: Preview = {
  parameters: { controls: { expanded: true }, a11y: { test: "error" } },
  tags: ["autodocs"],
};

export default preview;
`;
writeFile(".storybook/preview.ts", sbPreview);

// componentes shadcn kit
if (profile === "shadcn") {
  const kitDir = join(harnessRoot, "src", "components", "shadcn");
  if (existsSync(kitDir)) {
    for (const name of readdirSync(kitDir)) {
      const src = join(kitDir, name);
      if (!statSync(src).isFile()) continue;
      const rel = `src/components/shadcn/${name}`;
      const dst = join(target, rel);
      if (existsSync(dst)) backup(dst);
      else created.push(rel);
      if (existsSync(dst)) updated.push(rel);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
    }
  }
  const cnSrc = join(harnessRoot, "src", "lib", "cn.ts");
  if (existsSync(cnSrc)) {
    const rel = "src/lib/cn.ts";
    const dst = join(target, rel);
    if (existsSync(dst)) backup(dst);
    else created.push(rel);
    if (existsSync(dst)) updated.push(rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(cnSrc, dst);
  }
}

// docs
for (const f of ["BENCHMARK.md", "PATTERNS.md"]) {
  const src = join(harnessRoot, "docs", f);
  if (existsSync(src)) {
    const rel = `docs/${f}`;
    const dst = join(target, rel);
    if (existsSync(dst)) backup(dst);
    else created.push(rel);
    if (existsSync(dst)) updated.push(rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

// opencode commands, skills, agents skills
copyTreeRel(".opencode");
copyTreeRel(".agents");

// ---- mescla package.json (scripts) ----
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.scripts = pkg.scripts ?? {};
const scriptsToAdd = {
  "tokens:build": "node scripts/build-tokens.mjs",
  "verify": "bash scripts/verify.sh",
  "validate": "node scripts/validate.mjs",
  "migrate": "node scripts/migrate.mjs",
};
for (const [k, v] of Object.entries(scriptsToAdd)) {
  if (!pkg.scripts[k]) pkg.scripts[k] = v;
}
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");
updated.push("package.json (scripts)");

// ---- mescla opencode.jsonc (MCP storybook) ----
const ocPath = join(target, "opencode.jsonc");
let oc = {};
if (existsSync(ocPath)) {
  try {
    // strip comments best-effort
    const raw = readFileSync(ocPath, "utf8").replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    oc = JSON.parse(raw);
  } catch {
    oc = {};
  }
}
oc.mcp = oc.mcp ?? {};
oc.mcp.servers = oc.mcp.servers ?? {};
if (!oc.mcp.servers.storybook) {
  oc.mcp.servers.storybook = { type: "remote", url: "http://127.0.0.1:6006/mcp", oauth: false };
}
writeFileSync(ocPath, JSON.stringify(oc, null, 2) + "\n");
updated.push("opencode.jsonc (mcp.storybook)");

// ---- AGENTS doc complemento ----
const agentsPath = join(target, "AGENTS.frontend-harness.md");
const brandName = brand ?? pkg.name ?? "Harness";
const agentsContent = `# Harness de Frontend — ${brandName}

- Perfil ativo: **${profile}**. Tokens em \`tokens/*.json\` (DTCG); rode \`npm run tokens:build\` após editar.
- Gate mandatório pós-edição em \`src/\`: \`bash scripts/verify.sh\` (tokens → oxlint → tsc → tests → build).
- Migração/atualização: \`npm run migrate\` (ou \`node scripts/migrate.mjs --target .\`).
- Validação: \`npm run validate\`.
- Storybook: \`npx storybook dev -p 6006\`; MCP remoto \`http://127.0.0.1:6006/mcp\`.
- Nunca alucinar props: \`docs-list\` → \`docs-show\`. Após editar UI, pré-visualizar via \`stories-preview\`.
`;
writeFile("AGENTS.frontend-harness.md", agentsContent);

// ---- resultado ----
console.log(`\nharness migrate → ${target}`);
console.log(`perfil: ${profile}`);
console.log(`backup: ${backupRoot} (${backedUp} arquivo(s))`);
console.log(`\ncriados (${created.length}):`);
for (const f of created) console.log(`  + ${f}`);
console.log(`\natualizados (${updated.length}):`);
for (const f of updated) console.log(`  ~ ${updated.indexOf(f) >= 0 ? f : f}`);
if (skipped.length) {
  console.log(`\npreservados (${skipped.length}):`);
  for (const f of skipped) console.log(`  - ${f}`);
}

if (!noValidate) {
  if (!existsSync(join(target, "node_modules"))) {
    console.log("\nvalidate: pulado (node_modules ausente). Instale deps e rode `npm run validate`.");
  } else {
    console.log("\n=== validação ===");
    const res = spawnSync(process.execPath, [join(target, "scripts", "validate.mjs")], { cwd: target, stdio: "inherit" });
    if (res.status !== 0) process.exit(res.status ?? 1);
  }
}
