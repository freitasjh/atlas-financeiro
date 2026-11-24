#!/usr/bin/env node
// Valida instalação/estado do Harness em um projeto.
// Uso: node scripts/validate.mjs [--target <dir>]
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
function arg(name, fallback) {
  const flag = `--${name}`;
  const idx = process.argv.indexOf(flag);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}
const target = resolve(arg("target", process.cwd()));
process.chdir(target);

const pkg = existsSync("package.json") ? JSON.parse(readFileSync("package.json", "utf8")) : {};
const scripts = pkg.scripts ?? {};
let fail = 0;
function step(name, cmd, args) {
  if (!cmd) { console.log(`skip: ${name} (indisponível)`); return; }
  const res = spawnSync(cmd, args, { cwd: target, stdio: "pipe", encoding: "utf8", shell: true });
  if (res.status !== 0) {
    fail = 1;
    console.log(`=== FAIL: ${name} ===`);
    console.log((res.stderr || res.stdout || "").split("\n").slice(-30).join("\n"));
  } else {
    console.log(`ok: ${name}`);
  }
}

// arquivos mínimos
const required = [
  "scripts/build-tokens.mjs",
  "scripts/verify.sh",
  "scripts/validate.mjs",
  "scripts/migrate.mjs",
  "tokens/base.json",
  "tokens/semantic.json",
  ".oxlintrc.json",
];
for (const f of required) {
  if (!existsSync(f)) { console.log(`MISSING: ${f}`); fail = 1; }
  else console.log(`ok: ${f}`);
}

step("tokens", "npm", ["run", "-s", "tokens:build"]);
if (existsSync("frontend")) step("lint", "npx", ["oxlint", "frontend"]);
if (existsSync("tsconfig.json") || existsSync("tsconfig.app.json")) step("types", "npx", ["tsc", "--noEmit"]);
if (scripts.test) step("tests", "npm", ["run", "-s", "test"]);
if (scripts.build) step("build", "npm", ["run", "-s", "build"]);

if (fail) {
  console.error("validate: FALHOU");
  process.exit(1);
}
console.log("validate: OK");
