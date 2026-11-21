import path from 'path'
import { fileURLToPath } from 'url'
import { defineConfig, type Plugin } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const dirname = path.dirname(fileURLToPath(import.meta.url))

// SEC-01 (F-01/F-14/F-16): diretórios de projeto que nunca são conteúdo de
// app. `server.fs.deny` barra ARQUIVO; o fallback SPA do dev server responde
// 200 (HTML do app) para a URL de diretório e para arquivos em dot-directory
// (sirv não serve dot-dir), então a URL também é barrada explicitamente.
// Exportado para o teste unitário (vite.config.spec.ts) — a matriz do TASKS
// SEC-01 é contrato, não observação manual.
export const DENIED_URL_PREFIXES = [
  '/.agents',
  '/.doc',
  '/.opencode',
  '/.spec',
  '/.harness-backup',
  '/.backup-frontend',
  '/supabase',
  '/harness',
  '/dist',
  '/scripts',
] as const

// Arquivos de estado/governança na raiz do projeto. Também cobertos por
// `server.fs.deny`, mas aqui a negação é por URL (independe de resolução fs).
export const DENIED_ROOT_FILES = [
  '/.env',
  '/.harness-install.json',
  '/harness.config.json',
  '/package-lock.json',
  '/opencode.json',
  '/opencode.jsonc',
  '/tsconfig.tsbuildinfo',
  '/workflow-state.json',
] as const

const DENIED_BODY = '403 Forbidden — artefato de projeto nao e servido pelo dev server (SEC-01)\n'

function toPosixPath(value: string): string {
  return value.split(path.sep).join('/')
}

// Raiz do projeto em formato posix, base dos padrões de `fs.deny` ancorados.
export const PROJECT_ROOT = toPosixPath(path.resolve(dirname))

// SEC-01 (regressão fs-deny-vs-node_modules): o Vite 6 monta o matcher de
// `server.fs.deny` com `picomatch(patterns, { matchBase: false, dot: true })`
// e o aplica sobre o caminho ABSOLUTO do arquivo (`isFileLoadingAllowed`).
// Um padrão com `**/` inicial atravessa `node_modules`: `**/dist/**` casa
// `node_modules/vite/dist/client/client.mjs` e derruba `/@vite/client`
// (404/HTML, tela branca). Padrão sem `/` inicial (`dist/**`) fica relativo e
// portanto não casa caminho absoluto algum — proteção fantasma. O padrão
// correto é ancorado na raiz do projeto: `${PROJECT_ROOT}/dist/**`.
export function projectRootDenyPattern(relativeDir: string): string {
  return `${PROJECT_ROOT}/${toPosixPath(relativeDir).replace(/^\/+|\/+$/g, '')}/**`
}

// Diretórios de projeto ancorados na raiz (nunca em `node_modules`).
export const PROJECT_FS_DENY_DIRS = [
  '.doc',
  '.agents',
  '.spec',
  '.opencode',
  '.harness-backup',
  '.backup-frontend',
  'supabase',
  'harness',
  'dist',
] as const

// SEC-01: denylist de `server.fs.deny`. Auditoria do risco `node_modules`:
// - `**/*.sql`, `**/*.md`, `**/*.tar.gz`, `**/.env*` e os arquivos de raiz
//   (`package-lock.json`, `*.json` de governança, `tsconfig.tsbuildinfo`)
//   mantêm `**/` de propósito: casar uma cópia dentro de `node_modules` é
//   inofensivo (o dev server nunca serve essas extensões como módulo) e querer
//   negá-las em qualquer profundidade é o objetivo da regra;
// - diretórios usam `projectRootDenyPattern` porque neles mora conteúdo
//   executável/estático legítimo de dependência (`node_modules/vite/dist`,
//   `node_modules/<pkg>/dist`) — `**/` ali quebra o app.
export const FS_DENY_PATTERNS: readonly string[] = [
  '**/.env*',
  '**/*.sql',
  '**/*.md',
  '**/*.tar.gz',
  ...PROJECT_FS_DENY_DIRS.map(projectRootDenyPattern),
  '**/package-lock.json',
  '**/.harness-install.json',
  '**/harness.config.json',
  '**/opencode.json',
  '**/opencode.jsonc',
  '**/workflow-state.json',
  '**/tsconfig.tsbuildinfo',
]

export function isDeniedProjectArtifactUrl(rawUrl: string): boolean {
  const pathname = rawUrl.split('?')[0].split('#')[0]
  const deniedPrefix = DENIED_URL_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  )
  if (deniedPrefix) return true

  return DENIED_ROOT_FILES.some(
    (file) => pathname === file || (file === '/.env' && pathname.startsWith('/.env.')),
  )
}

export function denyProjectArtifactUrls(): Plugin {
  return {
    name: 'atlas-deny-project-artifact-urls',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!isDeniedProjectArtifactUrl(req.url ?? '/')) {
          next()
          return
        }
        res.statusCode = 403
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end(DENIED_BODY)
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), denyProjectArtifactUrls()],
  resolve: {
    alias: {
      '@': path.resolve(dirname, './src'),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    // SEC-01 (F-01/F-14/F-16): o dev server tem `root` = raiz do projeto, logo
    // qualquer artefato de governança/backup/migration era servido com 200.
    // `fs.deny` é a barreira; `fs.allow` continua implícito no root (HMR e
    // `/src/**` intactos). Nunca rode `vite --host` sem esta lista.
    // Os padrões de diretório vêm ancorados em `PROJECT_ROOT` — ver o comentário
    // de `FS_DENY_PATTERNS` (regressão fs-deny-vs-node_modules).
    fs: {
      deny: [...FS_DENY_PATTERNS],
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'react-vendor': ['react', 'react-dom', 'react-router-dom'],
          charts: ['recharts'],
          dnd: ['@dnd-kit/core', '@dnd-kit/modifiers', '@dnd-kit/sortable', '@dnd-kit/utilities'],
        },
      },
    },
  },
  test: {
    environment: 'happy-dom',
    exclude: ['.backup-frontend/**', '.opencode/**', 'node_modules/**', 'dist/**'],
    // GAP-2/H3: 217 arquivos em paralelo ilimitado estouravam o timeout padrão
    // de 5s em arquivos diferentes. Teto de 2 workers (medição QA) + limite
    // finito de 15s (default do modo browser) — sem retry/skip/passWithNoTests.
    maxWorkers: 2,
    testTimeout: 15_000,
  },
})

