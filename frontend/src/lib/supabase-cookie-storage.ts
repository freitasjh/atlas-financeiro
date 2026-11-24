// A-SESSION — persistência de sessão em cookie JS `sb-*` (D2a).
//
// O cookie carrega `access_token` + `refresh_token` do Supabase e, por decisão
// D2a (SPA pura, sem BFF), não tem `HttpOnly` — qualquer XSS lê e entrega o
// token. HttpOnly pleno é o débito do Módulo 4 (`@supabase/ssr`). Até lá, a
// janela do cookie é o único limite de tempo do takeover:
// `Max-Age = 8 h` = um turno de trabalho e bem abaixo do TTL padrão do
// refresh token do Supabase (604800 s = 7 dias). Cada `setItem` — login e cada
// refresh — reescreve o MESMO cookie (nome + `Path=/`) com a janela cheia, então
// uma sessão ativa não cai no meio do expediente e uma sessão ociosa exige
// re-login. Reduzir a janela encolhe o roubo; NÃO substitui CSP nem HttpOnly
// (ver `.doc/runbook-operacoes.md` §8).
export const SESSION_COOKIE_MAX_AGE_SECONDS = 8 * 60 * 60

export const SESSION_COOKIE_PREFIX = "sb-"

export interface CookieDocumentLike {
  cookie: string
}

export interface SessionCookieStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
  removeItem: (key: string) => void
}

export interface SessionCookieStorageOptions {
  /** Resolve o documento a cada operação (SSR/teste node devolvem `null`). */
  doc?: () => CookieDocumentLike | null
  /** Resolve `Secure` a cada escrita — a decisão depende do protocolo atual. */
  secure?: () => boolean
  maxAgeSeconds?: number
  prefix?: string
}

function defaultDoc(): CookieDocumentLike | null {
  return typeof document === "undefined" ? null : (document as unknown as CookieDocumentLike)
}

function defaultSecure(): boolean {
  return typeof window !== "undefined" && window.location.protocol === "https:"
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * C2-01 — há cookie de sessão `sb-*` no documento? Usado só para aquecer o
 * chunk do guard (que carrega supabase-js) em paralelo ao bootstrap. É sinal
 * de PRESENÇA, nunca de validade: a autorização continua no RLS e o guard lê
 * a sessão real pelo supabase-js.
 */
export function hasSessionCookie(
  raw: string | null | undefined,
  prefix = SESSION_COOKIE_PREFIX,
): boolean {
  if (!raw) return false
  return new RegExp(`(?:^|;\\s*)${escapeRegExp(prefix)}`).test(raw)
}

export function buildSessionCookie(
  name: string,
  value: string,
  maxAgeSeconds: number,
  secure: boolean,
): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=${maxAgeSeconds}`
}

export function buildExpiredSessionCookie(name: string, secure: boolean): string {
  return `${name}=; Path=/; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=0`
}

/**
 * Lê um cookie pelo nome exato. Valor malformado (percent-encoding inválido)
 * devolve `null`: sessão ilegível = sessão ausente, nunca exceção no boot.
 */
export function readCookieValue(
  raw: string | null | undefined,
  name: string,
): string | null {
  if (!raw) return null
  const match = raw.match(new RegExp(`(?:^|;\\s*)${escapeRegExp(name)}=([^;]*)`))
  if (!match) return null
  try {
    return decodeURIComponent(match[1] ?? "")
  } catch {
    return null
  }
}

/**
 * Adapter `storage` do supabase-js. Não há outro caminho para o token: leitura
 * e escrita existem só aqui (zero `localStorage`).
 */
/**
 * Expira todos os cookies `sb-*` presentes no documento (logout / limpeza).
 * Usado pelo `useAuthStore.signOut` para garantir que nenhum cookie de sessão
 * sobreviva ao logout, mesmo que o adapter do supabase-js não remova todos.
 */
export type ClearAllSessionCookiesOptions = {
  doc?: (() => CookieDocumentLike | null) | CookieDocumentLike | null
  secure?: boolean | (() => boolean)
}

export function clearAllSessionCookies(
  docOrOptions?:
    | CookieDocumentLike
    | null
    | ClearAllSessionCookiesOptions
    | (() => CookieDocumentLike | null),
  secureArg?: boolean | (() => boolean),
): void {
  let doc: CookieDocumentLike | null = defaultDoc()
  let secure: boolean | (() => boolean) = defaultSecure

  if (docOrOptions && typeof docOrOptions === "object" && "cookie" in docOrOptions) {
    doc = docOrOptions as CookieDocumentLike
  } else if (docOrOptions && typeof docOrOptions === "object") {
    const opts = docOrOptions as ClearAllSessionCookiesOptions
    if (typeof opts.doc === "function") {
      doc = (opts.doc as () => CookieDocumentLike | null)()
    } else if (opts.doc !== undefined) {
      doc = opts.doc
    }
    if (opts.secure !== undefined) secure = opts.secure
  } else if (docOrOptions !== undefined) {
    // Aceita tanto um documento quanto uma função resolvente (compat).
    if (typeof docOrOptions === "function") {
      const resolved = (docOrOptions as () => unknown)()
      if (resolved && typeof resolved === "object" && "cookie" in (resolved as object)) {
        doc = resolved as CookieDocumentLike
      }
    } else {
      doc = docOrOptions as CookieDocumentLike | null
    }
  }

  if (secureArg !== undefined) {
    if (secureArg && typeof secureArg === "object" && "secure" in (secureArg as object)) {
      secure = (secureArg as { secure: boolean | (() => boolean) }).secure
    } else {
      secure = secureArg as boolean | (() => boolean)
    }
  }

  if (!doc) return
  const secureFlag = typeof secure === "function" ? secure() : secure
  const names = doc.cookie
    .split(";")
    .map((part) => part.trim().split("=")[0] ?? "")
    .filter((name) => name.startsWith(SESSION_COOKIE_PREFIX))
  for (const name of names) {
    doc.cookie = buildExpiredSessionCookie(name, secureFlag)
  }
}

export function createSessionCookieStorage(
  options: SessionCookieStorageOptions = {},
): SessionCookieStorage {
  const doc = options.doc ?? defaultDoc
  const secure = options.secure ?? defaultSecure
  const maxAgeSeconds = options.maxAgeSeconds ?? SESSION_COOKIE_MAX_AGE_SECONDS
  const prefix = options.prefix ?? SESSION_COOKIE_PREFIX

  return {
    getItem: (key) => {
      const target = doc()
      if (!target) return null
      return readCookieValue(target.cookie, `${prefix}${key}`)
    },
    setItem: (key, value) => {
      const target = doc()
      if (!target) return
      target.cookie = buildSessionCookie(
        `${prefix}${key}`,
        value,
        maxAgeSeconds,
        secure(),
      )
    },
    removeItem: (key) => {
      const target = doc()
      if (!target) return
      target.cookie = buildExpiredSessionCookie(`${prefix}${key}`, secure())
    },
  }
}