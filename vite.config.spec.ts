import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import type { ViteDevServer } from 'vite'
import defaultConfig from './vite.config'
import {
  DENIED_ROOT_FILES,
  DENIED_URL_PREFIXES,
  PROJECT_FS_DENY_DIRS,
  PROJECT_ROOT,
  denyProjectArtifactUrls,
  isDeniedProjectArtifactUrl,
  projectRootDenyPattern,
} from './vite.config'

// SEC-01 (A3): a matriz 403/200 do TASKS §SEC-01 é contrato do dev server,
// não observação manual de curl. O plugin é exercitado por `configureServer`
// com um `middlewares.use` fake — nenhum servidor HTTP é levantado.

class FakeResponse {
  statusCode = 200
  body = ''
  headers: Record<string, string> = {}

  setHeader(name: string, value: string): void {
    this.headers[name] = value
  }

  end(chunk?: string): void {
    this.body = chunk ?? ''
  }
}

type Middleware = (req: { url?: string }, res: FakeResponse, next: () => void) => void

function mountMiddleware(): Middleware {
  const plugin = denyProjectArtifactUrls()
  const configureServer = plugin.configureServer as
    | ((server: ViteDevServer) => void)
    | undefined

  if (typeof configureServer !== 'function') {
    throw new Error('plugin sem configureServer')
  }

  let registered: Middleware | undefined
  const fakeServer = {
    middlewares: {
      use: (fn: Middleware) => {
        registered = fn
      },
    },
  } as unknown as ViteDevServer

  configureServer(fakeServer)

  if (!registered) {
    throw new Error('middleware nao registrado pelo plugin')
  }
  return registered
}

function probe(url: string): { res: FakeResponse; nextCalled: boolean } {
  const middleware = mountMiddleware()
  const res = new FakeResponse()
  let nextCalled = false

  middleware({ url }, res, () => {
    nextCalled = true
  })

  return { res, nextCalled }
}

const ALLOWED_URLS = ['/', '/src/main.tsx', '/@vite/client']

const DENIED_URLS = [
  '/.spec/',
  '/.doc/',
  '/.agents/',
  '/.opencode/',
  '/supabase/seed.sql',
  '/supabase/config.toml',
  '/harness.config.json',
  '/.harness-install.json',
  '/workflow-state.json',
  '/dist/',
  '/.harness-backup/',
]

describe('denyProjectArtifactUrls (SEC-01)', () => {
  it.each(ALLOWED_URLS)('deixa %s passar (next, sem 403)', (url) => {
    const { res, nextCalled } = probe(url)

    expect(nextCalled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.body).toBe('')
  })

  it.each(DENIED_URLS)('responde 403 para %s e nao chama next', (url) => {
    const { res, nextCalled } = probe(url)

    expect(nextCalled).toBe(false)
    expect(res.statusCode).toBe(403)
    expect(res.body).toContain('SEC-01')
    expect(res.headers['Content-Type']).toBe('text/plain; charset=utf-8')
  })

  it('nega com query string e hash intactos', () => {
    expect(probe('/supabase/seed.sql?download=1').res.statusCode).toBe(403)
    expect(probe('/.spec/#top').res.statusCode).toBe(403)
  })

  it('nao nega URL de app que apenas comeca com o mesmo prefixo textual', () => {
    expect(probe('/specification').nextCalled).toBe(true)
    expect(probe('/supabase-utils').nextCalled).toBe(true)
    expect(probe('/distinct').nextCalled).toBe(true)
    expect(probe('/harnessed').nextCalled).toBe(true)
  })

  it('nega .env e variantes na raiz', () => {
    expect(probe('/.env').res.statusCode).toBe(403)
    expect(probe('/.env.production').res.statusCode).toBe(403)
    expect(probe('/.env.local').res.statusCode).toBe(403)
  })

  it('cobre a matriz declarada: prefixo OU arquivo de raiz, nunca allowlist vazia', () => {
    expect(DENIED_URL_PREFIXES.length).toBeGreaterThan(0)
    expect(DENIED_ROOT_FILES.length).toBeGreaterThan(0)

    for (const url of DENIED_URLS) {
      expect(isDeniedProjectArtifactUrl(url)).toBe(true)
    }
    for (const url of ALLOWED_URLS) {
      expect(isDeniedProjectArtifactUrl(url)).toBe(false)
    }
    for (const file of ['/.harness-install.json', '/harness.config.json', '/workflow-state.json']) {
      expect(DENIED_ROOT_FILES).toContain(file)
    }
  })
})

// SEC-01: `server.fs.deny` é a barreira primária do dev server (arquivo real);
// o plugin acima é o complemento por URL. Os padrões críticos são contrato:
// sem eles, .env/migrations/docs/arquivos compactados voltam a ser servidos.
const FS_DENY_CRITICAL_PATTERNS = [
  '**/.env*',
  '**/*.sql',
  '**/*.md',
  '**/*.tar.gz',
  projectRootDenyPattern('.spec'),
  projectRootDenyPattern('supabase'),
  projectRootDenyPattern('dist'),
] as const

// Regressão fs-deny-vs-node_modules: o Vite 6 aplica `fs.deny` sobre o caminho
// ABSOLUTO (picomatch, matchBase:false, dot:true). Este matcher replica a
// montagem do Vite (`fsDenyGlob`) para provar a denylist real contra caminhos
// reais — sem levantar servidor HTTP.
type GlobMatcher = (input: string) => boolean
type PicomatchFactory = (
  glob: string | readonly string[],
  options: Record<string, unknown>,
) => GlobMatcher

const nodeRequire = createRequire(import.meta.url)
const picomatch = nodeRequire('picomatch') as PicomatchFactory

function buildViteFsDenyMatcher(patterns: readonly string[]): GlobMatcher {
  const viteFsDenyGlob = picomatch(
    patterns.map((pattern) => (pattern.includes('/') ? pattern : `**/${pattern}`)),
    { matchBase: false, nocase: true, dot: true },
  )
  return (input: string) => viteFsDenyGlob(input.split(path.sep).join('/'))
}

describe('server.fs.deny (SEC-01 barreira primaria)', () => {
  const deny: string[] = defaultConfig.server?.fs?.deny ?? []

  it.each(FS_DENY_CRITICAL_PATTERNS)('declara %s na denylist de fs', (pattern) => {
    expect(deny).toContain(pattern)
  })

  it('nao deixa a denylist vazia nem reduzida aos padroes criticos', () => {
    expect(deny.length).toBeGreaterThan(FS_DENY_CRITICAL_PATTERNS.length)
  })

  // Regressão: `**/dist/**` casava `node_modules/vite/dist/client/client.mjs`,
  // logo `/@vite/client` virava 404/HTML e o app ficava em tela branca.
  it('nao nega arquivos servidos de node_modules', () => {
    const isDenied = buildViteFsDenyMatcher(deny)

    const servedFromNodeModules = [
      `${PROJECT_ROOT}/node_modules/vite/dist/client/client.mjs`,
      `${PROJECT_ROOT}/node_modules/vite/dist/client/env.mjs`,
      `${PROJECT_ROOT}/node_modules/.vite/deps/react.js`,
      `${PROJECT_ROOT}/node_modules/react-dom/client.js`,
      `${PROJECT_ROOT}/node_modules/@supabase/supabase-js/dist/module/index.js`,
    ]

    for (const file of servedFromNodeModules) {
      expect(isDenied(file)).toBe(false)
    }
    expect(isDenied(`${PROJECT_ROOT}/src/main.tsx`)).toBe(false)
  })

  it('casa os padroes de diretorio apenas na raiz do projeto', () => {
    const isDenied = buildViteFsDenyMatcher(deny)

    const deniedOnProjectRoot = [
      `${PROJECT_ROOT}/dist/index.html`,
      `${PROJECT_ROOT}/.spec/backend/SPEC.md`,
      `${PROJECT_ROOT}/.agents/rules/DESIGN.md`,
      `${PROJECT_ROOT}/supabase/migrations/0001_fundacao.sql`,
      `${PROJECT_ROOT}/harness/report.json`,
      `${PROJECT_ROOT}/.env.local`,
    ]

    for (const file of deniedOnProjectRoot) {
      expect(isDenied(file)).toBe(true)
    }

    // Mesmo nome de diretório fora da raiz do projeto não é alvo do deny de
    // diretório (proteção é do projeto, nunca de dependência).
    expect(isDenied(`${PROJECT_ROOT}/node_modules/pkg/dist/index.js`)).toBe(false)
    expect(isDenied(`${PROJECT_ROOT}/node_modules/pkg/supabase/client.js`)).toBe(false)
  })

  it('ancora os padroes de diretorio em PROJECT_ROOT (nunca `**/` inicial)', () => {
    for (const relativeDir of PROJECT_FS_DENY_DIRS) {
      const pattern = projectRootDenyPattern(relativeDir)

      expect(pattern.startsWith('**/')).toBe(false)
      expect(pattern.startsWith(`${PROJECT_ROOT}/`)).toBe(true)
      expect(deny).toContain(pattern)
    }
  })
})
