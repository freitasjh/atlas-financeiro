#!/usr/bin/env node
// Instala o Harness de Frontend em um projeto React existente.
// Uso: node scripts/init.mjs --target ../meu-projeto --profile shadcn|claude
//      [--brand "Nome"] (default: nome do package.json do alvo)
// Respeita código existente: não sobrescreve arquivos, só cria os faltantes.
import { readFileSync, writeFileSync, mkdirSync, cpSync, existsSync, copyFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url)); // harness scripts/
const harnessRoot = resolve(here, "..");

function arg(name, fallback) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const targetArg = arg("target");
const profile = arg("profile", "shadcn");
const brand = arg("brand");
if (!targetArg) {
  console.error("uso: node scripts/init.mjs --target <dir> --profile shadcn|claude [--brand Nome]");
  process.exit(1);
}
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
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
const isNext = Boolean(deps.next || (pkg.dependencies?.next ?? pkg.devDependencies?.next));
const framework = isNext ? "@storybook/nextjs" : "@storybook/react-vite";
const brandName = brand ?? pkg.name ?? "Harness";
const created = [];
const skipped = [];

function createRepo(relPath, content, why = "") {
  const abs = join(target, relPath);
  if (existsSync(abs)) {
    skipped.push(`${relPath} ${why}`.trim());
    return;
  }
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  created.push(relPath);
}

function copyInto(relDir, fromDir) {
  for (const name of ["base.json", "semantic.json"]) {
    const src = join(fromDir, name);
    const dst = join(target, "tokens", name);
    if (existsSync(dst)) {
      skipped.push(`tokens/${name}`);
      continue;
    }
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
    created.push(`tokens/${name}`);
  }
}

// ---- DESIGN.md do perfil ----
const designSrc = join(harnessRoot, "profiles", profile, "DESIGN.md");
if (existsSync(designSrc)) {
  const rel = "DESIGN.md";
  const abs = join(target, rel);
  if (existsSync(abs)) {
    skipped.push(`${rel} (já existe)`);
  } else {
    mkdirSync(dirname(abs), { recursive: true });
    copyFileSync(designSrc, abs);
    created.push(rel);
  }
}

// ---- tokens do perfil ----
const profileTokensDir = join(harnessRoot, "profiles", profile, "tokens");
copyInto("tokens", profileTokensDir);
const themesDir = join(profileTokensDir, "themes");
if (existsSync(themesDir) && !existsSync(join(target, "tokens", "themes"))) {
  cpSync(themesDir, join(target, "tokens", "themes"), { recursive: true });
  created.push("tokens/themes/*");
}

const THEMES = profile === "claude" ? ["claude", "enterprise", "liquid"] : [];

// ---- builder de tokens (single-perfil) ----
const builder = `\
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

function load(p) { return JSON.parse(readFileSync(p, "utf8")); }
function flatten(obj, prefix) {
  const out = new Map();
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (k === "meta") continue;
    const path = prefix ? prefix + "." + k : k;
    if (typeof v === "object" && v !== null && !("$value" in v)) {
      for (const [ik, iv] of flatten(v, path)) out.set(ik, iv);
    } else if (typeof v === "object" && v !== null && "$value" in v) {
      out.set(path, { value: String(v.$value), type: v.$type });
    }
  }
  return out;
}
function resolve(value, pool, depth) {
  if (depth > 10) return value;
  const next = depth === undefined ? 0 : depth + 1;
  return value.replace(/\\{([^}]+)\\}/g, (m, ref) => {
    const hit = pool.get(ref);
    if (!hit) return m;
    return resolve(hit.value, pool, next);
  });
}
function cssVar(path) { return "--" + path.replace(/\\./g, "-"); }

const PROFILE = "${profile}";
const THEMES = ${JSON.stringify(THEMES)};
const base = flatten(JSON.parse(readFileSync("tokens/base.json", "utf8")));
const semantic = flatten(JSON.parse(readFileSync("tokens/semantic.json", "utf8")));

let css = "";
function emit(pool, name) {
  css += name + " {\\n";
  for (const path of pool.keys()) {
    const leaf = pool.get(path);
    css += "  " + cssVar(path) + ": " + resolve(leaf.value, pool) + ";\\n";
  }
  css += "}\\n\\n";
}

if (PROFILE === "shadcn") {
  const light = new Map([...base, ...semantic]);
  const darkOverride = flatten(JSON.parse(readFileSync("tokens/themes/dark.json", "utf8")));
  emit(light, ":root");
  const darkPool = new Map([...base, ...semantic, ...darkOverride]);
  // re-emit only override keys
  const onlyDark = new Map();
  for (const path of darkOverride.keys()) onlyDark.set(path, darkPool.get(path));
  emit(onlyDark, ".dark");
  css = css.replace(/\\n$/, "\\n\\n");
  const map = [
    "background", "foreground", "card", "card-foreground", "popover", "popover-foreground",
    "primary", "primary-foreground", "secondary", "secondary-foreground",
    "muted", "muted-foreground", "accent", "accent-foreground", "destructive",
    "border", "input", "ring", "chart-1", "chart-2", "chart-3", "chart-4", "chart-5",
    "sidebar", "sidebar-foreground", "sidebar-primary", "sidebar-primary-foreground",
    "sidebar-accent", "sidebar-accent-foreground", "sidebar-border", "sidebar-ring",
  ];
  css += "@theme inline {\\n";
  for (const t of map) css += "  --color-" + t + ": var(--" + t + ");\\n";
  css += "  --radius-sm: calc(var(--radius) - 4px);\\n";
  css += "  --radius-md: calc(var(--radius) - 2px);\\n";
  css += "  --radius-lg: var(--radius);\\n";
  css += "  --radius-xl: calc(var(--radius) + 4px);\\n";
  css += "}\\n";
} else {
  const poolDefault = new Map([...base, ...semantic]);
  const first = THEMES[0];
  const firstOverride = flatten(JSON.parse(readFileSync("tokens/themes/" + first + ".json", "utf8")));
  emit(new Map([...poolDefault, ...firstOverride]), ":root");
  for (const theme of THEMES.slice(1)) {
    const override = flatten(JSON.parse(readFileSync("tokens/themes/" + theme + ".json", "utf8")));
    emit(new Map([...poolDefault, ...override]), '[data-theme="' + theme + '"]');
  }
}
mkdirSync("src", { recursive: true });
writeFileSync("src/tokens-generated.css", css);
console.log("tokens:", PROFILE, "→ src/tokens-generated.css");
`;
createRepo(
  "scripts/build-tokens.mjs",
  builder,
  "(já existe — mantido)"
);

// ---- oxlint ----
createRepo(
  ".oxlintrc.json",
  JSON.stringify(
    {
      plugins: ["typescript", "react"],
      rules: {
        "typescript/no-explicit-any": "error",
        "typescript/no-non-null-assertion": "error",
        "typescript/no-floating-promises": "error",
        "react/jsx-key": "error",
        "react/rules-of-hooks": "error",
      },
    },
    null,
    2
  ) + "\n"
);

// ---- verify gate ----
const hasTest = Boolean(pkg.scripts?.test);
const hasTestRun = Boolean(pkg.scripts?.["test:run"]);
verifyScript();
function verifyScript() {
  const testCmd = hasTestRun ? "npm run -s test:run" : hasTest ? "npm run -s test" : "";
  const buildCmd = isNext ? "npm run -s build" : "";
  const lines = [
    "#!/usr/bin/env bash",
    "# Gate do Harness: silencioso no sucesso, verboso na falha.",
    "set -euo pipefail",
    'cd "$(dirname "$0")/.."',
    "fail=0",
    'step() { local n="$1"; shift; if ! out=$("$@" 2>&1); then fail=1; echo "=== FAIL: $n ==="; echo "$out" | tail -30; fi; }',
    'step "tokens" node scripts/build-tokens.mjs',
    'step "lint" npx oxlint src',
    'step "types" npx tsc --noEmit',
  ];
  if (testCmd) lines.push(`step "tests" ${testCmd}`);
  if (buildCmd) lines.push(`step "build" ${buildCmd}`);
  lines.push(
    'if [ "$fail" -eq 0 ]; then echo "verify: OK (tokens, lint, types' +
      (testCmd ? ", tests" : "") +
      (buildCmd ? ", build" : "") +
      ')"; else echo "verify: FALHOU — ver FAIL acima"; exit 1; fi',
    ""
  );
  createRepo("scripts/verify.sh", lines.join("\n"));
}

// ---- storybook ----
createRepo(
  ".storybook/main.ts",
  `\
import type { StorybookConfig } from "${framework}";

const config: StorybookConfig = {
  framework: "${framework}",
  stories: ["../src/**/*.stories.@(ts|tsx)", "../src/**/*.mdx"],
  addons: ["@storybook/addon-a11y", "@storybook/addon-mcp"],
  features: { componentsManifest: true },
};

export default config;
`
);

const cssImports = [
  'import "../src/tokens-generated.css";',
  existsSync(join(target, "src", "index.css")) ? 'import "../src/index.css";' : null,
  isNext && existsSync(join(target, "src", "app", "globals.css")) ? 'import "../src/app/globals.css";' : null,
].filter(Boolean);
createRepo(
  ".storybook/preview.ts",
  `\
${cssImports.join("\n")}

import type { Preview } from "${framework}";

const preview: Preview = {
  parameters: { controls: { expanded: true }, a11y: { test: "error" } },
  tags: ["autodocs"],
};

export default preview;
`
);

const storybookDeps = [
  'storybook@"^10.6.7"',
  `${framework}@"^10.6.7"`,
  '"@storybook/addon-a11y@^10.6.7"',
  '"@storybook/addon-mcp@^10.6.7"',
];

// ---- kit shadcn (somente perfil shadcn) ----
if (profile === "shadcn") {
  function buttonCva() {
    return `\
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";
import { cn } from "../../lib/cn";

// Raio derivado de --radius (md = radius * 0.8) — convenção shadcn.
const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-[calc(var(--radius)*0.8)] text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-primary/90",
        destructive: "bg-destructive text-white hover:bg-destructive/90",
        outline: "border border-input bg-background hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2",
        sm: "h-8 gap-1.5 px-3",
        lg: "h-10 px-6",
        icon: "size-9",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  }
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {}

function Button({ className, variant, size, ...props }: ButtonProps) {
  return <button className={cn(buttonVariants({ variant, size, className }))} {...props} />;
}

export { Button, buttonVariants };
`;
  }
  const cnPath = join(target, "src", "lib", "cn.ts");
  if (!existsSync(cnPath)) {
    mkdirSync(join(target, "src", "lib"), { recursive: true });
    writeFileSync(
      cnPath,
      'import { clsx, type ClassValue } from "clsx";\nimport { twMerge } from "tailwind-merge";\n\nexport function cn(...inputs: ClassValue[]) {\n  return twMerge(clsx(inputs));\n}\n'
    );
    created.push("src/lib/cn.ts");
  } else skipped.push("src/lib/cn.ts (já existe)");
  const port = 6006;
  createRepo(
    "src/components/shadcn/button.tsx",
    buttonCva(),
    "(adaptar classes de marca se necessário)"
  );
  createRepo("src/components/shadcn/index.ts", 'export { Button, buttonVariants, type ButtonProps } from "./button";\nexport { cn } from "../../lib/cn";\n');
  createRepo(
    "src/components/shadcn/button.stories.tsx",
    `\
import type { Meta, StoryObj } from "${framework}";
import { Button } from "./button";

const meta: Meta<typeof Button> = { title: "Shadcn/Button", component: Button, tags: ["autodocs"] };
export default meta;
type Story = StoryObj<typeof Button>;

export const Default: Story = { args: { children: "Ações" } };
export const Outline: Story = { args: { variant: "outline", children: "Filtrar" } };
export const Destructive: Story = { args: { variant: "destructive", children: "Excluir" } };
`
  );
  storybookDeps.push('"class-variance-authority@^0.7.1"', '"clsx@^2.1.1"', '"tailwind-merge@^2.5.4"');
}

// ---- AGENTS.md complemento ----
createRepo(
  "AGENTS.frontend-harness.md",
  `\
# Harness de Frontend — ${brandName}

- Perfil ativo: **${profile}**. Tokens em \`tokens/*.json\` (DTCG); rode \`npm run tokens:build\` após editar.
- Gate mandatório pós-edição em \`src/\`: \`bash scripts/verify.sh\` (tokens → oxlint → tsc${hasTest ? " → tests" : ""}${isNext ? " → build" : ""}).
- Migração/atualização: \`npm run migrate\` (ou \`node scripts/migrate.mjs --target .\`).
- Validação: \`npm run validate\`.
- Storybook: \`npx storybook dev -p ${6006}\`; MCP remoto \`http://127.0.0.1:6006/mcp\` (\`oauth: false\`) no \`opencode.json\`.
- Nunca alucinar props: \`docs-list\` → \`docs-show\`. Após editar UI, pré-visualizar via \`stories-preview\`.
- Anti-slop: sem 3-col simétrica, sem gradiente roxo, sem sombra dura em card, sem fonte fora dos tokens.

Deps recomendadas (npm i -D): ${storybookDeps.join(", ")}

Skill shadcn (opcional): \`npx skills add shadcn/ui\` — requer \`components.json\` (crie via \`npx shadcn@latest init\` ou copie o do harness). Dá ao agente acesso à documentação e helpers de registro shadcn no editor.

Blocos oficiais: \`npx shadcn@latest add @shadcn/dashboard-01 @shadcn/login-02\` — requer \`components.json\` e Tailwind v4; o CLI resolve componentes, dependências e CSS.
`
);

// ---- opencode commands, skills e agents (instala só o que falta) ----
function copyDirMissing(srcDir, dstDir) {
  if (!existsSync(srcDir)) return;
  for (const name of readdirSync(srcDir)) {
    const src = join(srcDir, name);
    const dst = join(dstDir, name);
    const st = statSync(src);
    if (st.isDirectory()) copyDirMissing(src, dst);
    else {
      if (existsSync(dst)) {
        skipped.push(relative(target, dst) + " (já existe)");
        continue;
      }
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(src, dst);
      created.push(relative(target, dst));
    }
  }
}
copyDirMissing(join(harnessRoot, ".opencode"), join(target, ".opencode"));
copyDirMissing(join(harnessRoot, ".agents"), join(target, ".agents"));
for (const f of ["scripts/migrate.mjs", "scripts/validate.mjs"]) {
  const src = join(harnessRoot, f);
  const dst = join(target, f);
  if (!existsSync(src)) continue;
  if (existsSync(dst)) {
    skipped.push(f + " (já existe)");
    continue;
  }
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(src, dst);
  created.push(f);
}

// ---- resultado ----
console.log(`\nharness init → ${target}`);
console.log(`perfil: ${profile} · framework: ${framework}`);
console.log(`\ncriados (${created.length}):`);
for (const f of created) console.log(`  + ${f}`);
if (skipped.length) {
  console.log(`\npreservados já existentes (${skipped.length}):`);
  for (const f of skipped) console.log(`  ~ ${f}`);
}
console.log("\npróximos passos:");
console.log("  1. npm i -D " + storybookDeps.join(" "));
console.log("  2. adicionar scripts: tokens:build, storybook (npx storybook dev -p 6006)");
console.log("  3. importar src/tokens-generated.css na entrada global (index.css/layout)");
console.log("  4. opencode.json → mcp.servers.storybook = { type:'remote', url:'http://127.0.0.1:6006/mcp', oauth:false }");
console.log("  5. bash scripts/verify.sh");
