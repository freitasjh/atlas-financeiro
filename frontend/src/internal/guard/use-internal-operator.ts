import { create } from "zustand"

import {
  gateStateFromLabel,
  isFresh,
  isGateState,
  verdictFromEdge,
  type GateFailure,
  type OperatorGateState,
  type SessionKey,
} from "./operator-gate"

/** Resultado de fio da Edge (ou falha de transporte) — o gate é quem decide. */
export interface OperatorWireResult {
  status: number | null
  body: unknown
  failure: GateFailure | null
}

/**
 * Dependências do store: o serviço HTTP e a chave da sessão são injetados pela
 * árvore interna (E8). O store não fala com `supabase` diretamente.
 *
 * `subscribeAuth` é opcional: quando presente, a árvore assina
 * `onAuthStateChange` para forçar `reset()` + `verify()` em troca de sessão.
 */
export interface OperatorRuntime {
  sessionKey: () => Promise<SessionKey>
  verify: () => Promise<OperatorWireResult>
  subscribeAuth?: (onChange: () => void) => () => void
}

let operatorRuntime: OperatorRuntime | null = null
let clock: () => number = () => Date.now()
let inFlight: Promise<OperatorGateState> | null = null

export function configureOperatorRuntime(runtime: OperatorRuntime | null): void {
  operatorRuntime = runtime
}

export function setOperatorClock(next: () => number): void {
  clock = next
}

/**
 * Assina a troca de sessão do Supabase (via runtime). Sem runtime ou sem
 * `subscribeAuth`, devolve um `unsubscribe` inerte — nunca lança.
 */
export function subscribeOperatorAuth(onChange: () => void): () => void {
  const runtime = operatorRuntime
  if (runtime === null || typeof runtime.subscribeAuth !== "function") return () => {}
  return runtime.subscribeAuth(onChange)
}

export interface InternalOperatorStore {
  state: OperatorGateState
  userId: string | null
  aalKey: SessionKey["aalKey"]
  checkedAt: number | null
  generation: number
  lastFailure: GateFailure | null
  verify: (options?: { force?: boolean }) => Promise<OperatorGateState>
  ensureFresh: () => Promise<boolean>
  requireOperator: (options?: { force?: boolean }) => Promise<boolean>
  invalidate: (stateOrLabel?: string) => OperatorGateState | null
  reset: () => void
}

/**
 * Store do guard — memória pura, **sem `persist`**: nenhum veredito sobrevive a
 * reload, aba nova ou storage do navegador (REQ-06/G-04).
 */
export const useInternalOperator = create<InternalOperatorStore>()((set, get) => {
  const runVerification = async (knownSession?: SessionKey): Promise<OperatorGateState> => {
    const generation = get().generation + 1
    // Revalidação em background: com veredito `operator` já aplicado, o estado
    // **não** volta para `checking` — o guard mantém os children montados e o
    // estado local das telas sobrevive (re-H3 F4 P2). `checking` fica só para o
    // primeiro load (sem veredito) e para depois de `reset`.
    const previous = get().state
    set({
      generation,
      state: previous === "operator" ? "operator" : "checking",
      lastFailure: null,
    })

    const runtime = operatorRuntime
    if (runtime === null) {
      set({ state: "error", lastFailure: "server" })
      return "error"
    }

    let session: SessionKey
    if (knownSession !== undefined) {
      session = knownSession
    } else {
      try {
        session = await runtime.sessionKey()
      } catch {
        session = { userId: null, aalKey: null }
      }
      if (generation !== get().generation) return get().state
    }

    let wire: OperatorWireResult
    try {
      wire = await runtime.verify()
    } catch {
      wire = { status: null, body: null, failure: "network" }
    }
    if (generation !== get().generation) return get().state

    const verdict = verdictFromEdge(wire.status, wire.body, wire.failure)
    if (
      verdict.state === "operator" &&
      session.userId !== null &&
      verdict.userId !== session.userId
    ) {
      // Resposta de outra conta em voo: descartada, nunca aplicada (REQ-11).
      return get().state
    }

    set({
      state: verdict.state,
      userId: verdict.state === "operator" ? (verdict.userId ?? session.userId) : null,
      aalKey: verdict.state === "operator" ? session.aalKey : null,
      checkedAt: clock(),
      lastFailure: verdict.failure,
    })
    return verdict.state
  }

  return {
    state: "unknown",
    userId: null,
    aalKey: null,
    checkedAt: null,
    generation: 0,
    lastFailure: null,

    verify: (options = {}) => {
      const { force = false } = options
      if (inFlight !== null) return inFlight

      const runAndTrack = (knownSession?: SessionKey): Promise<OperatorGateState> => {
        let run: Promise<OperatorGateState>
        run = runVerification(knownSession).finally(() => {
          if (inFlight === run) inFlight = null
        })
        inFlight = run
        return run
      }

      // `force` (escrita, retry, rótulo de gate) e ausência de runtime não
      // consultam cache: o próximo passo é a verificação.
      if (force || operatorRuntime === null) return runAndTrack()

      const runtime = operatorRuntime
      return (async () => {
        // A frescura é decidida contra a sessão **viva** — nunca contra o
        // próprio store, senão uma troca de conta (ou de `aal`) passaria.
        let live: SessionKey
        try {
          live = await runtime.sessionKey()
        } catch {
          live = { userId: null, aalKey: null }
        }
        if (inFlight !== null) return inFlight

        const latest = get()
        if (isFresh(latest, live, clock())) return latest.state
        return runAndTrack(live)
      })()
    },

    ensureFresh: async () => (await get().verify()) === "operator",

    requireOperator: async (options = {}) => {
      const { force = true } = options
      return (await get().verify({ force })) === "operator"
    },

    invalidate: (stateOrLabel) => {
      let mapped: OperatorGateState | null = null
      if (stateOrLabel !== undefined) {
        mapped = isGateState(stateOrLabel) ? stateOrLabel : gateStateFromLabel(stateOrLabel)
      }

      set({
        state: mapped ?? "unknown",
        userId: null,
        aalKey: null,
        checkedAt: null,
        generation: get().generation + 1,
        lastFailure: null,
      })

      if (mapped === null || mapped === "unknown" || mapped === "checking") return mapped

      // Uma revalidação por rótulo — nunca laço (SPEC §4.3).
      void get().verify({ force: true })
      return mapped
    },

    reset: () => {
      inFlight = null
      set({
        state: "unknown",
        userId: null,
        aalKey: null,
        checkedAt: null,
        lastFailure: null,
        generation: get().generation + 1,
      })
    },
  }
})
