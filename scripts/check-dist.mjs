// END-03/04 — verificação do artefato de build (falha fechada).
//
// `public/_headers` é TEMPLATE: contém `REPLACE_WITH_PROJECT_REF` e é copiado
// cru para `dist/` pelo Vite. Este script (rodado depois de `vite build`)
// substitui o marcador pelo project ref derivado de `VITE_SUPABASE_URL` ou
// `SUPABASE_PROJECT_REF` e audita o artefato final. Sem ref em produção o
// build é recusado — nunca publish de CSP quebrada ou headers ausentes.
//
// Também exporta as funções puras usadas pelos testes (`sec0-*`), para que a
// suíte meça o artefato em vez de duplicar regex.

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const PROJECT_REF_PLACEHOLDER = 'REPLACE_WITH_PROJECT_REF'
export const ANON_KEY_PLACEHOLDER = 'REPLACE_WITH_ANON_KEY'

const REF_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i

// Origem Supabase (https ou wss) com o ref explícito: `https://<ref>.supabase.co`.
const SUPABASE_ORIGIN_PATTERN = /(?:https|wss):\/\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.supabase\.co/gi

/** Refs de projeto Supabase citados num texto (`_headers` ou bundle). */
export function projectRefsInText(text) {
  const refs = new Set()
  for (const match of String(text ?? '').matchAll(SUPABASE_ORIGIN_PATTERN)) {
    if (match[1]) refs.add(match[1])
  }
  return refs
}

const REQUIRED_HEADERS = [
  { name: 'x-frame-options', label: 'X-Frame-Options: DENY', test: (v) => /^deny$/i.test(v) },
  {
    name: 'x-content-type-options',
    label: 'X-Content-Type-Options: nosniff',
    test: (v) => /^nosniff$/i.test(v),
  },
  {
    name: 'referrer-policy',
    label: 'Referrer-Policy: strict-origin-when-cross-origin',
    test: (v) => /^strict-origin-when-cross-origin$/i.test(v),
  },
  {
    name: 'permissions-policy',
    label: 'Permissions-Policy com camera/microphone/geolocation/payment/usb desligados',
    test: (v) =>
      /camera=\(\)/.test(v) &&
      /microphone=\(\)/.test(v) &&
      /geolocation=\(\)/.test(v) &&
      /payment=\(\)/.test(v) &&
      /usb=\(\)/.test(v),
  },
  {
    name: 'strict-transport-security',
    label: 'Strict-Transport-Security: max-age=31536000; includeSubDomains',
    test: (v) => /max-age=31536000/i.test(v) && /includeSubDomains/i.test(v),
  },
  {
    name: 'cross-origin-opener-policy',
    label: 'Cross-Origin-Opener-Policy: same-origin',
    test: (v) => /^same-origin$/i.test(v),
  },
]

/** Parseia `_headers` (formato Cloudflare) em `Map<diretiva, valor>` (lowercase). */
export function parseHeaders(text) {
  const map = new Map()
  for (const line of String(text).split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const idx = trimmed.indexOf(':')
    if (idx <= 0) continue
    const name = trimmed.slice(0, idx).trim().toLowerCase()
    const value = trimmed.slice(idx + 1).trim()
    if (name && value) map.set(name, value)
  }
  return map
}

/** Parseia o valor de `Content-Security-Policy` em `Map<diretiva, valores>`. */
export function parseCsp(value) {
  const map = new Map()
  for (const part of String(value).split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    if (tokens.length === 0) continue
    map.set(tokens[0].toLowerCase(), tokens.slice(1).join(' '))
  }
  return map
}

function auditCsp(cspText) {
  const errors = []
  const directives = parseCsp(cspText)
  const has = (name, expected) => {
    const value = directives.get(name)
    if (value === undefined) {
      errors.push(`CSP sem a diretiva ${name} (esperado: ${expected}).`)
      return false
    }
    if (value !== expected) {
      errors.push(`CSP com ${name} inválido: "${value}" (esperado: "${expected}").`)
      return false
    }
    return true
  }

  if (!directives.has('frame-ancestors')) {
    errors.push("CSP sem frame-ancestors 'none' — clickjacking fica aberto em produção.")
  } else if (directives.get('frame-ancestors') !== "'none'") {
    errors.push(`CSP com frame-ancestors "${directives.get('frame-ancestors')}" (esperado: 'none').`)
  }
  if (!directives.has('default-src')) {
    errors.push("CSP sem default-src (esperado: 'self').")
  } else if (!directives.get('default-src').split(/\s+/).includes("'self'")) {
    errors.push("CSP com default-src sem 'self'.")
  }
  has('script-src', "'self'")
  has('script-src-attr', "'none'")
  has('object-src', "'none'")
  has('base-uri', "'none'")

  if (!directives.has('style-src')) {
    errors.push("CSP sem style-src (esperado: 'self').")
  } else {
    const styleSrc = directives.get('style-src')
    if (!styleSrc.split(/\s+/).includes("'self'")) {
      errors.push("CSP com style-src sem 'self'.")
    }
    if (styleSrc.includes("'unsafe-inline'")) {
      errors.push(
        "CSP com style-src 'unsafe-inline' — use style-src 'self' e style-src-attr 'unsafe-inline'.",
      )
    }
  }
  if (!directives.has('style-src-attr')) {
    errors.push("CSP sem style-src-attr 'unsafe-inline' (atributos style do React).")
  } else if (directives.get('style-src-attr') !== "'unsafe-inline'") {
    errors.push(
      `CSP com style-src-attr "${directives.get('style-src-attr')}" (esperado: 'unsafe-inline').`,
    )
  }

  const connect = directives.get('connect-src')
  if (connect === undefined) {
    errors.push("CSP sem connect-src (esperado: 'self' + projeto Supabase).")
  } else {
    if (!connect.split(/\s+/).includes("'self'")) errors.push("CSP com connect-src sem 'self'.")
    if (connect.includes('*')) {
      errors.push('CSP com wildcard em connect-src — escopo deve ser o project ref explícito.')
    }
  }
  if (/unsafe-eval/i.test(cspText)) {
    errors.push('CSP contém unsafe-eval — proibido (script-src só self).')
  }
  return errors
}

/** Audita o conteúdo textual de `_headers`. Retorna lista de erros (vazia = ok). */
export function auditHeaders(text, options = {}) {
  const allowPlaceholder = options.allowPlaceholder === true
  const headers = parseHeaders(text)
  const errors = []

  if (headers.size === 0) {
    errors.push('_headers vazio ou ilegível — nenhum header de segurança declarado.')
    return errors
  }

  const csp = headers.get('content-security-policy')
  if (csp === undefined) {
    errors.push('_headers sem Content-Security-Policy.')
  } else {
    errors.push(...auditCsp(csp))
  }

  for (const header of REQUIRED_HEADERS) {
    const value = headers.get(header.name)
    if (value === undefined) {
      errors.push(`_headers sem ${header.label}.`)
    } else if (!header.test(value)) {
      errors.push(`_headers com ${header.name} inválido: "${value}" (esperado: ${header.label}).`)
    }
  }

  if (/unsafe-eval/i.test(String(text))) {
    errors.push('_headers contém unsafe-eval — proibido.')
  }

  if (String(text).includes(PROJECT_REF_PLACEHOLDER) && !allowPlaceholder) {
    errors.push(
      `_headers ainda contém ${PROJECT_REF_PLACEHOLDER} — project ref não substituído no build.`,
    )
  }
  return errors
}

/** Audita `index.html` do artefato. */
export function auditIndexHtml(html) {
  const errors = []
  if (/http-equiv\s*=\s*["']?Content-Security-Policy/i.test(String(html))) {
    errors.push(
      'dist/index.html contém <meta http-equiv="Content-Security-Policy"> — a política é só por header.',
    )
  }
  if (/localhost/i.test(String(html))) {
    errors.push('dist/index.html contém "localhost" — host local vazou para o artefato.')
  }
  if (/127\.0\.0\.1/.test(String(html))) {
    errors.push('dist/index.html contém "127.0.0.1" — host local vazou para o artefato.')
  }
  return errors
}

/**
 * Audita um chunk JS do artefato.
 *
 * `allowPlaceholder` é o escape hatch do build LOCAL (nunca em
 * `NODE_ENV=production` — `runCheckDist` desliga a flag nesse caso): um build de
 * dev sem env real carrega os marcadores de `.env.production`. O default é
 * estrito; produção nunca chega aqui com a flag ligada.
 *
 * `expectedRef` é o project ref declarado no `connect-src` de `dist/_headers`.
 * Divergência entre o header e o bundle é falha fechada: a CSP autoriza um host
 * que o app não usa (ou o app chama um host bloqueado).
 */
export function auditBundle(code, name = 'dist/assets/*.js', options = {}) {
  const errors = []
  const text = String(code)
  const allowPlaceholder = options.allowPlaceholder === true
  if (!allowPlaceholder) {
    if (text.includes(PROJECT_REF_PLACEHOLDER)) {
      errors.push(`${name} contém ${PROJECT_REF_PLACEHOLDER} — project ref não substituído no bundle.`)
    }
    if (text.includes(ANON_KEY_PLACEHOLDER)) {
      errors.push(`${name} contém ${ANON_KEY_PLACEHOLDER} — anon key placeholder vazou para o bundle.`)
    }
  }
  const expectedRef = options.expectedRef
  if (expectedRef) {
    for (const ref of projectRefsInText(text)) {
      if (ref !== expectedRef) {
        errors.push(
          `${name} referencia o project ref "${ref}", mas dist/_headers (connect-src) declara "${expectedRef}" — divergência entre CSP e bundle.`,
        )
      }
    }
  }
  // `@supabase/auth-js` publica a constante `DEFAULT_AUTH_URL =
  // 'http://localhost:9999'` no bundle. É default de biblioteca, nunca o host
  // configurado pela aplicação — o allowlist é o valor exato, não `localhost*`.
  const stripped = text.split('http://localhost:9999').join('')
  if (stripped.includes('http://127.0.0.1')) {
    errors.push(`${name} contém http://127.0.0.1 — host local vazou para o bundle.`)
  }
  if (stripped.includes('http://localhost')) {
    errors.push(`${name} contém http://localhost — host local vazou para o bundle.`)
  }
  return errors
}

/** Deriva o project ref de `SUPABASE_PROJECT_REF` ou `VITE_SUPABASE_URL`. */
export function deriveProjectRef(env = {}) {
  const explicit = (env.SUPABASE_PROJECT_REF ?? '').trim()
  if (explicit && explicit !== PROJECT_REF_PLACEHOLDER) {
    if (!REF_PATTERN.test(explicit)) {
      throw new Error(`SUPABASE_PROJECT_REF inválido: "${explicit}" (use o ref do projeto).`)
    }
    return explicit
  }
  const raw = (env.VITE_SUPABASE_URL ?? '').trim()
  if (!raw) return null
  let url
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (!/\.supabase\.co$/i.test(url.hostname)) return null
  const ref = url.hostname.split('.')[0]
  if (!ref || !REF_PATTERN.test(ref)) return null
  return ref
}

/** Substitui o marcador do template. Template sem marcador = falha alta. */
export function substituteProjectRef(template, ref) {
  if (!ref || !REF_PATTERN.test(ref)) {
    throw new Error('project ref ausente/inválido — derive de VITE_SUPABASE_URL ou SUPABASE_PROJECT_REF.')
  }
  if (!String(template).includes(PROJECT_REF_PLACEHOLDER)) {
    throw new Error(`public/_headers sem marcador ${PROJECT_REF_PLACEHOLDER} — template inválido.`)
  }
  return String(template).split(PROJECT_REF_PLACEHOLDER).join(ref)
}

function readBundles(assetsDir, options = {}) {
  const errors = []
  let entries
  try {
    entries = readdirSync(assetsDir)
  } catch {
    errors.push('dist/assets ausente — rode `vite build` antes do check-dist.')
    return errors
  }
  const scripts = entries.filter((entry) => entry.endsWith('.js'))
  if (scripts.length === 0) {
    errors.push('dist/assets sem bundle .js — artefato incompleto.')
    return errors
  }
  for (const file of scripts) {
    const code = readFileSync(join(assetsDir, file), 'utf8')
    errors.push(...auditBundle(code, `dist/assets/${file}`, options))
  }
  return errors
}

/** Audita o diretório `dist/` já construído. */
export function checkDist(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const distDir = resolve(cwd, options.distDir ?? 'dist')
  const allowPlaceholder = options.allowPlaceholder === true
  const errors = []

  const headersPath = join(distDir, '_headers')
  let expectedRef = null
  if (!existsSync(headersPath)) {
    errors.push('dist/_headers ausente — Vite não copiou public/_headers.')
  } else {
    const headersText = readFileSync(headersPath, 'utf8')
    errors.push(...auditHeaders(headersText, { allowPlaceholder }))
    const headerRefs = [...projectRefsInText(headersText)]
    if (headerRefs.length === 1) {
      expectedRef = headerRefs[0]
    } else if (headerRefs.length > 1) {
      errors.push(
        `dist/_headers declara mais de um project ref (${headerRefs.join(', ')}) — o connect-src deve apontar para um único projeto.`,
      )
    }
  }

  const indexPath = join(distDir, 'index.html')
  if (!existsSync(indexPath)) {
    errors.push('dist/index.html ausente — artefato incompleto.')
  } else {
    errors.push(...auditIndexHtml(readFileSync(indexPath, 'utf8')))
  }

  errors.push(...readBundles(join(distDir, 'assets'), { allowPlaceholder, expectedRef }))
  return errors
}

/**
 * Fluxo do CLI: lê o template, grava `dist/_headers` substituído e audita.
 * `--allow-placeholder` só vale fora de `NODE_ENV=production`.
 */
export function runCheckDist(options = {}) {
  const cwd = options.cwd ?? process.cwd()
  const env = options.env ?? process.env
  const log = options.log ?? ((line) => console.log(line))
  const production = env.NODE_ENV === 'production'
  const allowPlaceholder = options.allowPlaceholder === true && !production
  const warnings = []
  const errors = []

  const templatePath = join(cwd, 'public', '_headers')
  const distDir = join(cwd, 'dist')
  if (!existsSync(templatePath)) {
    errors.push('public/_headers ausente — template de headers de segurança não encontrado.')
  } else if (!existsSync(distDir)) {
    errors.push('dist/ ausente — rode `vite build` antes do check-dist.')
  } else {
    const template = readFileSync(templatePath, 'utf8')
    const distHeadersPath = join(distDir, '_headers')
    const distHeaders = existsSync(distHeadersPath) ? readFileSync(distHeadersPath, 'utf8') : ''
    const distHasPlaceholder = distHeaders.includes(PROJECT_REF_PLACEHOLDER)
    const ref = deriveProjectRef(env)
    if (ref) {
      try {
        writeFileSync(distHeadersPath, substituteProjectRef(template, ref), 'utf8')
        log(`check-dist: project ref "${ref}" aplicado em dist/_headers.`)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    } else if (!distHasPlaceholder) {
      log('check-dist: dist/_headers já está sem placeholder (ref aplicado em build anterior).')
    } else if (production) {
      errors.push(
        'VITE_SUPABASE_URL/SUPABASE_PROJECT_REF ausente com NODE_ENV=production — recusando publicar placeholder.',
      )
    } else if (options.allowPlaceholder === true) {
      warnings.push(
        `dist/_headers mantém ${PROJECT_REF_PLACEHOLDER} (modo dev com --allow-placeholder; nunca em produção).`,
      )
    } else {
      errors.push(
        `dist/_headers ainda contém ${PROJECT_REF_PLACEHOLDER} — defina VITE_SUPABASE_URL ou SUPABASE_PROJECT_REF.`,
      )
    }
  }

  errors.push(...checkDist({ cwd, allowPlaceholder }))

  for (const warning of warnings) log(`check-dist WARN: ${warning}`)
  for (const error of errors) log(`check-dist FAIL: ${error}`)
  if (errors.length === 0) log('check-dist OK: artefato de headers/bundle íntegro.')
  return { code: errors.length === 0 ? 0 : 1, errors, warnings }
}

function main() {
  const result = runCheckDist({
    allowPlaceholder: process.argv.slice(2).includes('--allow-placeholder'),
  })
  process.exitCode = result.code
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) main()
