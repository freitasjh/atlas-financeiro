/**
 * Bindings, roteamento e entrypoints do Worker.
 *
 * O handler HTTP é puro (`./core.js`); aqui mora só o que toca o runtime:
 * leitura de `env`, `fetch` para a RPC e o log. Nenhum import de `node:` ou
 * `cloudflare:` — os globais (`fetch`, `AbortSignal`, `console`) bastam.
 */

import { handleWebhook, RPC_TIMEOUT_MS } from './core.js'

const DRAIN_RPC = 'drain_psp_events'
const SCRUB_RPC = 'scrub_psp_events'
export const SCRUB_CRON = '0 6 * * *'

/**
 * Orçamento do cron, separado do de admissão (Adendo A10): `drain`/`scrub` são
 * transações únicas e um abort faz rollback total — `attempts` não incrementa
 * e `scrubbed` não avança. 5 s de admissão congelaria o scrub em progresso
 * zero para sempre.
 */
export const CRON_RPC_TIMEOUT_MS = 30000

/**
 * @param {Record<string, unknown>} env
 * @returns {(name: string, args?: Record<string, unknown>, options?: { timeoutMs?: number }) => Promise<{ status: number, data: unknown }>}
 */
export function createRpc(env) {
  return async function rpc(name, args = {}, options = {}) {
    const baseUrl = String(env.SUPABASE_URL ?? '').replace(/\/+$/, '')
    const serviceKey = String(env.SUPABASE_SERVICE_ROLE_KEY ?? '')
    const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS
    const response = await fetch(`${baseUrl}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: serviceKey,
        Authorization: `Bearer ${serviceKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const data = await response.json().catch(() => null)
    return { status: response.status, data }
  }
}

/**
 * Dependências reais injetadas no handler puro.
 * @param {Record<string, unknown>} env
 * @returns {{ rpc: Function, enqueue: Function, log: Function }}
 */
export function createDeps(env) {
  const rpc = createRpc(env)
  return {
    rpc,
    enqueue: (message) => env.PSP_QUEUE.send(message),
    log: (fields) => console.log(JSON.stringify(fields)),
  }
}

/**
 * @param {unknown} body
 * @returns {string | null}
 */
function readEventId(body) {
  if (body === null || typeof body !== 'object') return null
  const candidate = /** @type {{ eventId?: unknown, event_id?: unknown }} */ (body)
  const value = candidate.eventId ?? candidate.event_id
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * Corpo do cron extraído do entrypoint para ser testável sem runtime de borda.
 * `result.data` é o único ponto onde os contadores de REQ-44/Adendo A7 podem
 * ser lidos (inteiros, zero PII; o contrato de 6 chaves de REQ-41 é do webhook).
 * @param {{ cron?: string }} controller
 * @param {{ rpc: Function, log: Function }} deps
 * @returns {Promise<void>}
 */
export async function runScheduled(controller, deps) {
  const rpcName = controller?.cron === SCRUB_CRON ? SCRUB_RPC : DRAIN_RPC
  try {
    const result = await deps.rpc(rpcName, {}, { timeoutMs: CRON_RPC_TIMEOUT_MS })
    deps.log({ scheduled: rpcName, status: result.status, result: result.data })
  } catch {
    deps.log({ scheduled: rpcName, status: 'error' })
  }
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, unknown>} env
   * @returns {Promise<Response>}
   */
  async fetch(request, env) {
    return handleWebhook({ request, env, deps: createDeps(env) })
  },

  /**
   * Consumer da fila: drena um evento por mensagem (SPEC §6 caminho 1).
   * @param {{ messages: Array<{ body: unknown, ack: Function, retry: Function }> }} batch
   * @param {Record<string, unknown>} env
   * @returns {Promise<void>}
   */
  async queue(batch, env) {
    const deps = createDeps(env)
    for (const message of batch.messages) {
      const eventId = readEventId(message.body)
      if (eventId === null) {
        message.ack()
        continue
      }
      try {
        // Mesmo orçamento do cron (Adendo A10): `drain` roda em transação única
        // e um abort faz rollback total — `attempts` não incrementa. Os 5 s de
        // admissão congelariam o retry da fila até o DLQ.
        const result = await deps.rpc(DRAIN_RPC, { p_event_id: eventId }, {
          timeoutMs: CRON_RPC_TIMEOUT_MS,
        })
        if (result.status >= 200 && result.status < 300) {
          message.ack()
        } else {
          message.retry()
        }
      } catch {
        message.retry()
      }
    }
  },

  /**
   * Crons: dreno de 5 min e scrub diário (SPEC §3, REQ-42).
   * @param {{ cron?: string }} controller
   * @param {Record<string, unknown>} env
   * @returns {Promise<void>}
   */
  async scheduled(controller, env) {
    await runScheduled(controller, createDeps(env))
  },
}
