import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// Harness multi-perfil: cada projeto declara "profile" e consome só o CSS
// gerado do seu perfil. O harness-frontend (app Claude) gera os dois para
// poder demonstrar os componentes shadcn re-tematizados em paralelo.
//
// Saída:
//   claude → src/tokens-generated.css   (temas data-theme)
//   shadcn → src/tokens-shadcn.css      (:root claro + .dark escuro)

function load(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

function flatten(obj, prefix = "") {
  const out = new Map();
  for (const [k, v] of Object.entries(obj)) {
    if (k === "meta") continue;
    const path = prefix === "" ? k : `${prefix}.${k}`;
    if (typeof v === "object" && v !== null && !("$value" in v)) {
      for (const [ik, iv] of flatten(v, path)) out.set(ik, iv);
    } else if (typeof v === "object" && v !== null && "$value" in v) {
      out.set(path, { value: String(v.$value), type: v.$type });
    }
  }
  return out;
}

function resolve(value, pool, depth = 0) {
  if (depth > 10) return value;
  return value.replace(/\{([^}]+)\}/g, (m, ref) => {
    const hit = pool.get(ref);
    if (!hit) return m;
    return resolve(hit.value, pool, depth + 1);
  });
}

function cssVar(path) {
  return "--" + path.replace(/\./g, "-");
}

function assertNoCollision(name, vars) {
  const seen = new Map();
  for (const key of vars.keys()) {
    if (seen.has(key)) {
      throw new Error(`[tokens] colisão de variável (${name}): --${key}`);
    }
    seen.set(key, true);
  }
}

function buildClaude() {
  const root = "profiles/claude/tokens";
  const base = flatten(load(`${root}/base.json`));
  const semantic = flatten(load(`${root}/semantic.json`));
  const themes = ["claude", "enterprise", "liquid"];

  let css = "";
  const poolDefault = new Map([...base, ...semantic]);
  const claudeOverride = flatten(load(`${root}/themes/claude.json`));
  const poolClaude = new Map([...poolDefault, ...claudeOverride]);
  assertNoCollision("claude", poolClaude);
  css += ":root {\n";
  for (const [path, leaf] of poolClaude) {
    css += `  ${cssVar(path)}: ${resolve(leaf.value, poolClaude)};\n`;
  }
  css += "}\n\n";

  for (const theme of themes) {
    if (theme === "claude") continue;
    const override = flatten(load(`${root}/themes/${theme}.json`));
    const pool = new Map([...poolDefault, ...override]);
    assertNoCollision(`claude:${theme}`, pool);
    css += `[data-theme="${theme}"] {\n`;
    for (const [path, leaf] of override) {
      css += `  ${cssVar(path)}: ${resolve(leaf.value, pool)};\n`;
    }
    css += "}\n\n";
  }
  return css;
}

function buildShadcn() {
  const root = "profiles/shadcn/tokens";
  const base = flatten(load(`${root}/base.json`));
  const semantic = flatten(load(`${root}/semantic.json`));
  const dark = flatten(load(`${root}/themes/dark.json`));

  const light = new Map([...base, ...semantic]);
  const darkPool = new Map([...base, ...semantic, ...dark]);
  assertNoCollision("shadcn", darkPool);

  let css = "";
  css += ":root {\n";
  for (const [path, leaf] of light) {
    css += `  ${cssVar(path)}: ${resolve(leaf.value, light)};\n`;
  }
  css += "}\n\n.dark {\n";
  for (const [path, leaf] of dark) {
    css += `  ${cssVar(path)}: ${resolve(leaf.value, darkPool)};\n`;
  }
  css += "}\n\n";

  // Mapeia os tokens semânticos shadcn para utilities Tailwind
  // (bg-primary, text-muted-foreground, …). Nomes únicos: não colidem com
  // o perfil claude (--color-* de claude são da paleta primitiva).
  // Raio NÃO vira utility: componentes usam calc(var(--radius) * k)
  // (fórmula shadcn sm=0.6 md=0.8 lg=1 xl=1.4 2xl=1.8) para não
  // sobrescrever a escala de raio do tema ativo.
  const map = [
    "background", "foreground",
    "card", "card-foreground",
    "popover", "popover-foreground",
    "primary", "primary-foreground",
    "secondary", "secondary-foreground",
    "muted", "muted-foreground",
    "accent", "accent-foreground",
    "destructive",
    "border", "input", "ring",
    "chart-1", "chart-2", "chart-3", "chart-4", "chart-5",
    "sidebar", "sidebar-foreground",
    "sidebar-primary", "sidebar-primary-foreground",
    "sidebar-accent", "sidebar-accent-foreground",
    "sidebar-border", "sidebar-ring",
  ];
  css += "@theme inline {\n";
  for (const t of map) {
    css += `  --color-${t}: var(--${t});\n`;
  }
  // Utilities de raio do shadcn: rounded-sm/md/lg/xl seguem --radius.
  css += "  --radius-sm: calc(var(--radius) - 4px);\n";
  css += "  --radius-md: calc(var(--radius) - 2px);\n";
  css += "  --radius-lg: var(--radius);\n";
  css += "  --radius-xl: calc(var(--radius) + 4px);\n";
  // Tipografia oficial Atlas: Inter (sans) + JetBrains Mono (mono).
  css += "  --font-sans: var(--font-sans);\n";
  css += "  --font-mono: var(--font-mono);\n";
  css += "}\n";
  // Modo escuro por classe .dark (convenção shadcn), não por media-query.
  css += "@custom-variant dark (&:is(.dark *));\n";
  return css;
}

const outputs = new Map([
  ["claude", { css: buildClaude(), file: "src/tokens-generated.css" }],
  ["shadcn", { css: buildShadcn(), file: "src/tokens-shadcn.css" }],
]);

for (const [profile, { css, file }] of outputs) {
  mkdirSync("src", { recursive: true });
  writeFileSync(file, css);
  console.log(`tokens:${profile} → ${file}`);
}
