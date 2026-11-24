/**
 * Revalidação do veredito de operador (SPEC §4.2).
 *
 * Gatilhos implementados aqui:
 *   1. `window.focus` e `visibilitychange → visible` — forçados quando passou
 *      mais de `FOCUS_REVALIDATE_MIN_INTERVAL_MS` desde o último veredito **ou**
 *      o estado não é `operator`.
 *   2. `onAuthStateChange` (`SIGNED_IN`/`SIGNED_OUT`/`TOKEN_REFRESHED`/
 *      `USER_UPDATED`) ⇒ `reset()` + `verify()`.
 *   3. TTL expirado em navegação/nova montagem ⇒ `verify({ force: true })`.
 *
 * Navegar com veredito quente (dentro do TTL) **não** chama a Edge.
 */

import { useEffect } from "react"
import { useLocation } from "react-router-dom"

import { FOCUS_REVALIDATE_MIN_INTERVAL_MS, OPERATOR_CACHE_TTL_MS } from "./operator-gate"
import { subscribeOperatorAuth, useInternalOperator } from "./use-internal-operator"

/**
 * Decide se um evento de foco/visibilidade deve forçar revalidação. Estado ≠
 * `operator` sempre revalida; `operator` só quando o intervalo anti-thrash já
 * passou (relógio para trás conta como expirado).
 */
export function shouldRevalidateOnFocus(
  state: string,
  checkedAt: number | null,
  now: number,
): boolean {
  if (state !== "operator") return true
  if (checkedAt === null) return true
  const age = now - checkedAt
  return age < 0 || age > FOCUS_REVALIDATE_MIN_INTERVAL_MS
}

/** TTL expirado ⇒ a próxima navegação precisa revalidar. */
export function isCacheExpired(checkedAt: number | null, now: number): boolean {
  if (checkedAt === null) return true
  const age = now - checkedAt
  return age < 0 || age >= OPERATOR_CACHE_TTL_MS
}

export function useOperatorRevalidation(): void {
  const location = useLocation()

  useEffect(() => {
    const revalidate = () => {
      const store = useInternalOperator.getState()
      if (!shouldRevalidateOnFocus(store.state, store.checkedAt, Date.now())) return
      void store.verify({ force: true })
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible") revalidate()
    }

    window.addEventListener("focus", revalidate)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.removeEventListener("focus", revalidate)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [])

  // TTL na montagem e em cada navegação. A montagem também é coberta aqui
  // (efeito roda no primeiro render), então uma nova montagem com cache velho
  // revalida mesmo sem foco.
  useEffect(() => {
    const store = useInternalOperator.getState()
    if (store.state !== "operator") return
    if (!isCacheExpired(store.checkedAt, Date.now())) return
    void store.verify({ force: true })
  }, [location.pathname])

  // Troca de sessão: reset + verify. O trabalho é deferido para fora do
  // callback do Supabase (evita disputar o lock do GoTrue).
  useEffect(
    () =>
      subscribeOperatorAuth(() => {
        queueMicrotask(() => {
          const store = useInternalOperator.getState()
          store.reset()
          void store.verify()
        })
      }),
    [],
  )
}
