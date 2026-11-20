/**
 * Handler puro do webhook Asaas.
 *
 * Nenhum import de `cloudflare:` nem de `node:` — o módulo roda no runtime de
 * borda e em `vitest` (ambiente node) sem shim. Toda dependência externa chega
 * por `deps` (`rpc`, `enqueue`, `log`), o que permite testar a matriz HTTP
 * inteira sem rede e sem banco.
 */

export const MAX_BODY_BYTES = 65536
export const WEBHOOK_PATH = '/webhooks/asaas'
export const HEALTH_PATH = '/webhooks/asaas/health'
export const RPC_TIMEOUT_MS = 5000

// Usado quando o header está ausente/vazio: a comparação precisa rodar mesmo
// assim para não criar oráculo de latência (REQ-38).
const DUMMY_TOKEN = 'constant-time-dummy-token-placeholder'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/**
 * Comparação de bytes em tempo constante. Acumula `diff` e faz um único
 * `return` no fim — nunca retorna dentro do laço.
 * @param {Uint8Array} leftBytes
 * @param {Uint8Array} rightBytes
 * @returns {boolean}
 */
export function constantTimeEqual(leftBytes, rightBytes) {
  let diff = leftBytes.length ^ rightBytes.length
  const max = Math.max(leftBytes.length, rightBytes.length)
  for (let index = 0; index < max; index += 1) {
    diff |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0)
  }
  return diff === 0
}

/**
 * @param {string} value
 * @returns {Promise<Uint8Array>}
 */
async function digestBytes(value) {
  const data = encoder.encode(value)
  const subtle = globalThis.crypto?.subtle
  if (!subtle) return data
  const digest = await subtle.digest('SHA-256', data)
  return new Uint8Array(digest)
}

/**
 * sha256 dos dois lados + comparação constante (REQ-38).
 * @param {string | null} provided
 * @param {string} expected
 * @returns {Promise<boolean>}
 */
export async function verifyToken(provided, expected) {
  const candidate = typeof provided === 'string' && provided.length > 0 ? provided : DUMMY_TOKEN
  const [left, right] = await Promise.all([digestBytes(candidate), digestBytes(expected)])
  return constantTimeEqual(left, right)
}

/**
 * @param {number} status
 * @param {Record<string, unknown>} body
 * @returns {Response}
 */
function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
  })
}

/**
 * @param {Request} request
 * @returns {boolean}
 */
function declaredBodyTooLarge(request) {
  const declared = request.headers.get('content-length')
  if (declared === null || declared === '') return false
  const size = Number(declared)
  return Number.isFinite(size) && size > MAX_BODY_BYTES
}

/**
 * Reforça o limite durante a leitura: não confia só no header.
 * @param {Request} request
 * @returns {Promise<{ tooLarge: boolean, bytes: Uint8Array | null }>}
 */
async function readBodyWithinLimit(request) {
  if (!request.body) return { tooLarge: false, bytes: new Uint8Array(0) }
  const reader = request.body.getReader()
  const chunks = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {})
      return { tooLarge: true, bytes: null }
    }
    chunks.push(value)
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { tooLarge: false, bytes }
}

/**
 * @param {Uint8Array} bytes
 * @returns {{ ok: true, value: unknown } | { ok: false }}
 */
function parseJson(bytes) {
  try {
    return { ok: true, value: JSON.parse(decoder.decode(bytes)) }
  } catch {
    return { ok: false }
  }
}

/**
 * Borda valida forma mínima; nunca valida forma de negócio (SPEC §4.1).
 * @param {unknown} payload
 * @returns {boolean}
 */
function isValidEvent(payload) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return false
  const { id, event } = /** @type {{ id?: unknown, event?: unknown }} */ (payload)
  if (typeof id !== 'string' || id.length === 0 || id.length > 255) return false
  if (typeof event !== 'string' || event.length === 0 || event.length > 128) return false
  return true
}

/**
 * Rótulo fixo de rejeição determinística da RPC de admissão (`0066:119`).
 * PostgREST devolve o erro em `{ code, message, details, hint }`.
 */
const DETERMINISTIC_REJECTION_LABEL = 'psp-event-invalid'

/**
 * `400` com o rótulo de inválido é decisão de conteúdo, não falha interna.
 * O rótulo pode chegar em `message` (formato observado do PostgREST, com o
 * SQLSTATE em `code`) ou em `code`.
 * @param {{ status: number, data: unknown }} result
 * @returns {boolean}
 */
function isDeterministicRejection(result) {
  if (result.status !== 400) return false
  const data = result.data
  if (data === null || typeof data !== 'object') return false
  const { code, message } = /** @type {{ code?: unknown, message?: unknown }} */ (data)
  const inMessage =
    typeof message === 'string' && message.includes(DETERMINISTIC_REJECTION_LABEL)
  const inCode = typeof code === 'string' && code === DETERMINISTIC_REJECTION_LABEL
  return inMessage || inCode
}

/**
 * @param {{ rpc?: Function }} deps
 * @param {{ id: string, event: string }} payload
 * @returns {Promise<{ ok: boolean, deterministic?: boolean, outcome?: string }>}
 */
async function callIngest(deps, payload) {
  let result
  try {
    result = await deps.rpc(
      'ingest_psp_event',
      { p_payload: payload, p_event_id: payload.id, p_event_type: payload.event },
      { timeoutMs: RPC_TIMEOUT_MS },
    )
  } catch {
    return { ok: false }
  }
  if (!result || typeof result.status !== 'number') {
    return { ok: false }
  }
  // Rejeição determinística: o mesmo payload nunca passa — devolver 503 faria
  // o PSP retentar até pausar a fila. A borda mede texto e a RPC mede
  // `pg_column_size`; na faixa divergente o Worker aceita e a RPC recusa.
  if (isDeterministicRejection(result)) {
    return { ok: false, deterministic: true }
  }
  if (result.status < 200 || result.status >= 300) {
    return { ok: false }
  }
  const outcome = result.data?.outcome === 'duplicate' ? 'duplicate' : 'stored'
  return { ok: true, outcome }
}

/**
 * Best-effort: falha de enfileirar não muda o 200 — o cron é a rede (REQ-42).
 * @param {{ enqueue?: Function }} deps
 * @param {{ id: string, event: string }} payload
 * @returns {Promise<void>}
 */
async function enqueueBestEffort(deps, payload) {
  if (typeof deps.enqueue !== 'function') return
  try {
    await deps.enqueue({ eventId: payload.id, eventType: payload.event })
  } catch {
    // silêncio proposital: dreno por cron é o caminho garantido
  }
}

/**
 * Log com exatamente 6 chaves, zero payload/PII (REQ-41).
 * @param {{ log?: Function }} deps
 * @param {{ eventId: string | null, eventType: string | null, outcome: string, httpStatus: number, latencyMs: number, cfRay: string | null }} fields
 * @returns {void}
 */
function emitLog(deps, fields) {
  if (typeof deps.log !== 'function') return
  deps.log({
    event_id: fields.eventId,
    event_type: fields.eventType,
    outcome: fields.outcome,
    http_status: fields.httpStatus,
    latency_ms: fields.latencyMs,
    cf_ray: fields.cfRay,
  })
}

/**
 * Handler puro (SPEC §5, REQ-36).
 * @param {{ request: Request, env: Record<string, unknown>, deps: { rpc: Function, enqueue?: Function, log?: Function } }} input
 * @returns {Promise<Response>}
 */
export async function handleWebhook({ request, env, deps }) {
  const startedAt = Date.now()
  const cfRay = request.headers.get('cf-ray')
  let eventId = null
  let eventType = null
  let outcome = 'error'
  let httpStatus = 500
  let response

  try {
    const pathname = new URL(request.url).pathname

    if (pathname === HEALTH_PATH) {
      if (request.method !== 'GET') {
        httpStatus = 405
        outcome = 'method-not-allowed'
        response = jsonResponse(405, { error: 'method-not-allowed' })
      } else {
        httpStatus = 200
        outcome = 'healthy'
        response = jsonResponse(200, { ok: true })
      }
    } else if (pathname !== WEBHOOK_PATH) {
      httpStatus = 404
      outcome = 'not-found'
      response = jsonResponse(404, { error: 'not-found' })
    } else if (request.method !== 'POST') {
      httpStatus = 405
      outcome = 'method-not-allowed'
      response = jsonResponse(405, { error: 'method-not-allowed' })
    } else if (declaredBodyTooLarge(request)) {
      httpStatus = 413
      outcome = 'payload-too-large'
      response = jsonResponse(413, { error: 'payload-too-large' })
    } else {
      const expectedToken = typeof env?.ASAAS_WEBHOOK_TOKEN === 'string' ? env.ASAAS_WEBHOOK_TOKEN : ''
      if (expectedToken.length === 0) {
        httpStatus = 503
        outcome = 'unavailable'
        response = jsonResponse(503, { error: 'unavailable' })
      } else {
        const tokenOk = await verifyToken(request.headers.get('asaas-access-token'), expectedToken)
        if (!tokenOk) {
          httpStatus = 401
          outcome = 'unauthorized'
          response = jsonResponse(401, { error: 'unauthorized' })
        } else {
          const body = await readBodyWithinLimit(request)
          if (body.tooLarge) {
            httpStatus = 413
            outcome = 'payload-too-large'
            response = jsonResponse(413, { error: 'payload-too-large' })
          } else {
            const parsed = parseJson(/** @type {Uint8Array} */ (body.bytes))
            if (!parsed.ok) {
              httpStatus = 400
              outcome = 'invalid-body'
              response = jsonResponse(400, { error: 'invalid-body' })
            } else if (!isValidEvent(parsed.value)) {
              httpStatus = 400
              outcome = 'invalid-event'
              response = jsonResponse(400, { error: 'invalid-event' })
            } else {
              const payload = /** @type {{ id: string, event: string }} */ (parsed.value)
              eventId = payload.id
              eventType = payload.event
              const ingested = await callIngest(deps, payload)
              if (ingested.deterministic) {
                httpStatus = 400
                outcome = 'invalid-event'
                response = jsonResponse(400, { error: 'invalid-event' })
              } else if (!ingested.ok) {
                httpStatus = 503
                outcome = 'unavailable'
                response = jsonResponse(503, { error: 'unavailable' })
              } else {
                await enqueueBestEffort(deps, payload)
                httpStatus = 200
                outcome = /** @type {string} */ (ingested.outcome)
                response = jsonResponse(200, { received: true })
              }
            }
          }
        }
      }
    }
  } catch {
    httpStatus = 500
    outcome = 'error'
    response = jsonResponse(500, { error: 'error' })
  }

  emitLog(deps, {
    eventId,
    eventType,
    outcome,
    httpStatus,
    latencyMs: Date.now() - startedAt,
    cfRay,
  })
  return response
}

/**
 * Alias de assinatura posicional usada pelos testes e por consumidores simples.
 * @param {Request} request
 * @param {Record<string, unknown>} env
 * @param {{ rpc: Function, enqueue?: Function, log?: Function }} deps
 * @returns {Promise<Response>}
 */
export function handle(request, env, deps) {
  return handleWebhook({ request, env, deps })
}
