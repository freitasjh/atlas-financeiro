// @vitest-environment node
/**
 * T10–T16 — matriz HTTP do webhook Asaas (SPEC §4.1, §12).
 * Handler puro: nenhuma rede, nenhum banco, nenhum runtime de borda.
 */
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import {
  MAX_BODY_BYTES,
  RPC_TIMEOUT_MS,
  constantTimeEqual,
  handle,
  handleWebhook,
  verifyToken,
} from './core.js'

const TOKEN = 'test-token-value'
const ENV = { ASAAS_WEBHOOK_TOKEN: TOKEN }
const CORE_URL = new URL('./core.js', import.meta.url)
const INDEX_URL = new URL('./index.js', import.meta.url)
const TEST_URL = new URL('./core.test.js', import.meta.url)
const WRANGLER_URL = new URL('../wrangler.toml', import.meta.url)

const CORE_SOURCE = readFileSync(fileURLToPath(CORE_URL), 'utf8')
const WRANGLER_SOURCE = readFileSync(fileURLToPath(WRANGLER_URL), 'utf8')

function makeDeps(overrides = {}) {
  return {
    rpc: vi.fn(async () => ({ status: 200, data: { stored: true, outcome: 'stored' } })),
    enqueue: vi.fn(async () => undefined),
    log: vi.fn(),
    ...overrides,
  }
}

function makeRequest({
  path = '/webhooks/asaas',
  method = 'POST',
  token = TOKEN,
  body,
  headers = {},
} = {}) {
  const requestHeaders = new Headers(headers)
  if (token !== null) requestHeaders.set('asaas-access-token', token)
  const init = { method, headers: requestHeaders }
  if (method !== 'GET' && method !== 'HEAD') {
    init.body =
      body === undefined ? JSON.stringify({ id: 'evt_1', event: 'PAYMENT_CONFIRMED' }) : body
  }
  return new Request(`https://hooks.example.test${path}`, init)
}

async function call({ request, env = ENV, deps = makeDeps() } = {}) {
  const response = await handleWebhook({
    request: request ?? makeRequest(),
    env,
    deps,
  })
  const text = await response.text()
  return { response, text, status: response.status, deps }
}

describe('T10 — estrutura e roteamento', () => {
  it('whenGetHealth_then200OkSemTocarNoBanco', async () => {
    const deps = makeDeps({
      rpc: vi.fn(async () => {
        throw new Error('rpc nao deveria ser chamada no health')
      }),
    })
    const { status, text } = await call({
      request: makeRequest({ path: '/webhooks/asaas/health', method: 'GET', token: null }),
      deps,
    })
    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({ ok: true })
    expect(deps.rpc).not.toHaveBeenCalled()
  })

  it('whenMetodoErradoNoWebhook_then405', async () => {
    const { status, text, deps } = await call({
      request: makeRequest({ method: 'GET' }),
    })
    expect(status).toBe(405)
    expect(JSON.parse(text)).toEqual({ error: 'method-not-allowed' })
    expect(deps.rpc).not.toHaveBeenCalled()
  })

  it('whenPathDesconhecido_then404', async () => {
    const { status, text, deps } = await call({
      request: makeRequest({ path: '/webhooks/outro' }),
    })
    expect(status).toBe(404)
    expect(JSON.parse(text)).toEqual({ error: 'not-found' })
    expect(deps.rpc).not.toHaveBeenCalled()
  })

  it('whenWorkerSource_thenSemImportDeCloudflareOuNode', () => {
    expect(existsSync(fileURLToPath(CORE_URL))).toBe(true)
    expect(existsSync(fileURLToPath(INDEX_URL))).toBe(true)
    expect(existsSync(fileURLToPath(TEST_URL))).toBe(true)
    expect(CORE_SOURCE).not.toMatch(/^\s*import\s[^\n]*cloudflare:/m)
    expect(CORE_SOURCE).not.toMatch(/^\s*import\s[^\n]*['"]node:/m)
    expect(CORE_SOURCE).not.toMatch(/^\s*import\s/m)
  })

  it('whenHandlePosicional_thenMesmoContrato', async () => {
    const response = await handle(makeRequest(), ENV, makeDeps())
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ received: true })
  })
})

describe('T11 — token em tempo constante', () => {
  it('whenTokenAusente_then401SemDetalhe', async () => {
    const { status, text, deps } = await call({ request: makeRequest({ token: null }) })
    expect(status).toBe(401)
    expect(JSON.parse(text)).toEqual({ error: 'unauthorized' })
    expect(deps.rpc).not.toHaveBeenCalled()
  })

  it('whenTokenVazio_then401IdenticoAoAusente', async () => {
    const ausente = await call({ request: makeRequest({ token: null }) })
    const vazio = await call({ request: makeRequest({ token: '' }) })
    const errado = await call({ request: makeRequest({ token: 'token-errado' }) })
    expect(ausente.status).toBe(401)
    expect(vazio.status).toBe(401)
    expect(errado.status).toBe(401)
    expect(vazio.text).toBe(ausente.text)
    expect(errado.text).toBe(ausente.text)
  })

  it('whenTokenCorreto_then200EIngestUmaVez', async () => {
    const { status, text, deps } = await call()
    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({ received: true })
    expect(deps.rpc).toHaveBeenCalledTimes(1)
    expect(deps.rpc.mock.calls[0][0]).toBe('ingest_psp_event')
    expect(deps.rpc.mock.calls[0][1]).toMatchObject({
      p_event_id: 'evt_1',
      p_event_type: 'PAYMENT_CONFIRMED',
    })
    // Orçamento de admissão: literal fixo — mutar `RPC_TIMEOUT_MS → 30000`
    // sobrevivia porque `toMatchObject` só olhava os args da RPC.
    expect(RPC_TIMEOUT_MS).toBe(5000)
    expect(deps.rpc.mock.calls[0][2]).toEqual({ timeoutMs: 5000 })
  })

  it('whenSecretNaoConfigurado_then503FailClosed', async () => {
    const { status, text, deps } = await call({ env: {} })
    expect(status).toBe(503)
    expect(JSON.parse(text)).toEqual({ error: 'unavailable' })
    expect(deps.rpc).not.toHaveBeenCalled()
  })

  it('whenSecretNaoConfigurado_then503SemLerCorpo', async () => {
    // REQ-38: fail-closed ocorre ANTES de qualquer leitura de corpo. A prova
    // principal é o stream: `pull()` lança, então `request.text()` (e qualquer
    // `body.getReader().read()`) rejeita, o handler cai no `catch` externo e
    // responde 500 — logo o 503 aqui só pode vir da guarda de segredo. O getter
    // `body` que marca acesso é defesa redundante (pega o caminho que lê
    // `request.body` direto), não a prova principal.
    const stream = new ReadableStream({
      pull() {
        throw new Error('corpo-nao-deveria-ser-lido')
      },
    })
    const request = new Request('https://hooks.example.test/webhooks/asaas', {
      method: 'POST',
      headers: new Headers({ 'asaas-access-token': TOKEN }),
      body: stream,
      duplex: 'half',
    })
    let accessed = false
    Object.defineProperty(request, 'body', {
      configurable: true,
      get() {
        accessed = true
        throw new Error('corpo-nao-deveria-ser-lido')
      },
    })

    const { status, text, deps } = await call({ request, env: {} })
    expect(status).toBe(503)
    expect(JSON.parse(text)).toEqual({ error: 'unavailable' })
    expect(accessed).toBe(false)
    expect(deps.rpc).not.toHaveBeenCalled()
  })

  it('whenComparacaoDeToken_thenSemSaidaAntecipada', async () => {
    const start = CORE_SOURCE.indexOf('export function constantTimeEqual')
    expect(start).toBeGreaterThan(-1)
    const end = CORE_SOURCE.indexOf('\n}', start)
    const body = CORE_SOURCE.slice(start, end + 2)
    expect(body).toContain('diff |=')
    // Invariante real: exatamente uma saída, no fim — nunca dentro do laço.
    // A asserção de `return` sozinha deixava passar a mutação
    // `if (leftBytes[i] === 255) break` (provado por mutação no review).
    expect((body.match(/\breturn\b/g) ?? []).length).toBe(1)
    expect(body).not.toMatch(/if\s*\([^)]*\)\s*\{?\s*return/)
    // `break` e `throw` encerram o laço/empilham saída antecipada. `continue`
    // NÃO entra na classe: salta para a próxima iteração e mantém o custo
    // constante — é implementação legítima de `for...of`, não saída.
    expect(body).not.toMatch(/\b(break|throw)\b/)

    // `verifyToken` também não antecipa saída: um único `return`, no fim.
    const verifyStart = CORE_SOURCE.indexOf('export async function verifyToken')
    expect(verifyStart).toBeGreaterThan(-1)
    const verifyEnd = CORE_SOURCE.indexOf('\n}', verifyStart)
    const verifyBody = CORE_SOURCE.slice(verifyStart, verifyEnd + 2)
    expect((verifyBody.match(/\breturn\b/g) ?? []).length).toBe(1)
    expect(verifyBody).not.toMatch(/\b(break|throw)\b/)

    expect(CORE_SOURCE).not.toMatch(/asaas-access-token[^\n]*===/)
  })

  it('whenBytesIguaisOuDiferentes_thenResultadoCorreto', async () => {
    const same = new Uint8Array([1, 2, 3])
    expect(constantTimeEqual(same, new Uint8Array([1, 2, 3]))).toBe(true)
    expect(constantTimeEqual(same, new Uint8Array([1, 2, 4]))).toBe(false)
    expect(constantTimeEqual(same, new Uint8Array([1, 2]))).toBe(false)
    expect(await verifyToken(TOKEN, TOKEN)).toBe(true)
    expect(await verifyToken('outro', TOKEN)).toBe(false)
  })
})

describe('T12 — corpo: limite e forma', () => {
  it('whenCorpoNaoJson_then400InvalidBody', async () => {
    const { status, text, deps } = await call({
      request: makeRequest({ body: 'nao-e-json' }),
    })
    expect(status).toBe(400)
    expect(JSON.parse(text)).toEqual({ error: 'invalid-body' })
    expect(deps.rpc).not.toHaveBeenCalled()
  })

  it('whenJsonSemId_then400InvalidEvent', async () => {
    const { status, text } = await call({
      request: makeRequest({ body: JSON.stringify({ event: 'PAYMENT_CONFIRMED' }) }),
    })
    expect(status).toBe(400)
    expect(JSON.parse(text)).toEqual({ error: 'invalid-event' })
  })

  it('whenEventNaoString_then400InvalidEvent', async () => {
    const { status } = await call({
      request: makeRequest({ body: JSON.stringify({ id: 'evt_1', event: 42 }) }),
    })
    expect(status).toBe(400)
  })

  it('whenContentLengthAcimaDoLimite_then413SemChamarRpc', async () => {
    const { status, text, deps } = await call({
      request: makeRequest({ headers: { 'content-length': String(MAX_BODY_BYTES + 1) } }),
    })
    expect(status).toBe(413)
    expect(JSON.parse(text)).toEqual({ error: 'payload-too-large' })
    expect(deps.rpc).not.toHaveBeenCalled()
  })

  it('whenCorpoAcimaDoLimiteSemHeader_then413DuranteALeitura', async () => {
    const { status, text, deps } = await call({
      request: makeRequest({ body: 'a'.repeat(MAX_BODY_BYTES + 1) }),
    })
    expect(status).toBe(413)
    expect(JSON.parse(text)).toEqual({ error: 'payload-too-large' })
    expect(deps.rpc).not.toHaveBeenCalled()
  })
})

describe('T13/T14 — 200 só após persistir; falha interna nunca 4xx', () => {
  it('whenRpc5xx_then503Nunca200', async () => {
    const deps = makeDeps({ rpc: vi.fn(async () => ({ status: 500, data: null })) })
    const { status, text } = await call({ deps })
    expect(status).toBe(503)
    expect(JSON.parse(text)).toEqual({ error: 'unavailable' })
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it('whenRpcRejeita_then503Nunca2xx', async () => {
    const deps = makeDeps({
      rpc: vi.fn(async () => {
        throw new Error('timeout')
      }),
    })
    const { status, text } = await call({ deps })
    expect(status).toBe(503)
    expect(JSON.parse(text)).toEqual({ error: 'unavailable' })
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it('whenRpc400ComPspEventInvalidNaMessage_then400SemRetry', async () => {
    // Rejeição determinística da RPC (régua de `pg_column_size`) devolve ao
    // PSP um 400: retentar o mesmo payload nunca passa e 15 falhas pausam a
    // fila no Asaas. Formato do erro do PostgREST: { code, message, ... }.
    const deps = makeDeps({
      rpc: vi.fn(async () => ({
        status: 400,
        data: { code: 'P0001', message: 'psp-event-invalid', details: null, hint: null },
      })),
    })
    const { status, text } = await call({ deps })
    expect(status).toBe(400)
    expect(JSON.parse(text)).toEqual({ error: 'invalid-event' })
    expect(deps.enqueue).not.toHaveBeenCalled()
    const logged = deps.log.mock.calls[0][0]
    expect(logged.http_status).toBe(400)
    expect(logged.outcome).toBe('invalid-event')
  })

  it('whenRpc400ComPspEventInvalidNoCode_then400', async () => {
    const deps = makeDeps({
      rpc: vi.fn(async () => ({ status: 400, data: { code: 'psp-event-invalid' } })),
    })
    const { status } = await call({ deps })
    expect(status).toBe(400)
  })

  it('whenRpc400SemRotulo_then503FailClosed', async () => {
    const deps = makeDeps({
      rpc: vi.fn(async () => ({
        status: 400,
        data: { code: '23503', message: 'insert or update violates foreign key constraint' },
      })),
    })
    const { status, text } = await call({ deps })
    expect(status).toBe(503)
    expect(JSON.parse(text)).toEqual({ error: 'unavailable' })
  })

  it('T14b whenRpc503ComRotuloNaMessage_then503Nunca400', async () => {
    // A guarda de status vem ANTES do rótulo: um 5xx com o texto de inválido
    // continua sendo falha interna. Sem este caso, inverter a ordem das guardas
    // (rótulo primeiro) devolveria 400 e ninguém notaria.
    const deps = makeDeps({
      rpc: vi.fn(async () => ({ status: 503, data: { message: 'psp-event-invalid' } })),
    })
    const { status, text } = await call({ deps })
    expect(status).toBe(503)
    expect(JSON.parse(text)).toEqual({ error: 'unavailable' })
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it('T14b whenRpc400ComRotuloExtraNoCode_then503IgualdadeNaoSubstring', async () => {
    // Em `code` a comparação é igualdade, não substring: `psp-event-invalid-extra`
    // não é o rótulo e a RPC não pode virar 400 determinístico.
    const deps = makeDeps({
      rpc: vi.fn(async () => ({ status: 400, data: { code: 'psp-event-invalid-extra' } })),
    })
    const { status, text } = await call({ deps })
    expect(status).toBe(503)
    expect(JSON.parse(text)).toEqual({ error: 'unavailable' })
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it('whenFalhaInterna_thenNunca4xx', async () => {
    for (const rpc of [
      vi.fn(async () => ({ status: 400, data: null })),
      vi.fn(async () => ({ status: 404, data: null })),
      vi.fn(async () => ({ status: 503, data: null })),
      vi.fn(async () => {
        throw new Error('network')
      }),
    ]) {
      const { status } = await call({ deps: makeDeps({ rpc }) })
      expect(status).toBe(503)
    }
  })
})

describe('T15 — enfileiramento best-effort e log sem PII', () => {
  it('whenDuplicado_then200EEnfileira', async () => {
    const deps = makeDeps({
      rpc: vi.fn(async () => ({ status: 200, data: { stored: false, outcome: 'duplicate' } })),
    })
    const { status } = await call({ deps })
    expect(status).toBe(200)
    expect(deps.enqueue).toHaveBeenCalledTimes(1)
    expect(deps.enqueue.mock.calls[0][0]).toEqual({
      eventId: 'evt_1',
      eventType: 'PAYMENT_CONFIRMED',
    })
  })

  it('whenEnqueueFalha_then200Mantido', async () => {
    const deps = makeDeps({
      enqueue: vi.fn(async () => {
        throw new Error('queue offline')
      }),
    })
    const { status, text } = await call({ deps })
    expect(status).toBe(200)
    expect(JSON.parse(text)).toEqual({ received: true })
  })

  it('whenLog_thenExatamenteSeisChavesSemPayload', async () => {
    const payload = {
      id: 'evt_1',
      event: 'PAYMENT_CONFIRMED',
      customer: { name: 'Fulano de Tal', email: 'pii@example.test', cpfCnpj: '12345678900' },
    }
    const deps = makeDeps()
    const { status } = await call({
      request: makeRequest({ body: JSON.stringify(payload) }),
      deps,
    })
    expect(status).toBe(200)
    expect(deps.log).toHaveBeenCalledTimes(1)
    const logged = deps.log.mock.calls[0][0]
    expect(Object.keys(logged).sort()).toEqual([
      'cf_ray',
      'event_id',
      'event_type',
      'http_status',
      'latency_ms',
      'outcome',
    ])
    expect(logged.http_status).toBe(200)
    expect(logged.event_id).toBe('evt_1')
    expect(logged.event_type).toBe('PAYMENT_CONFIRMED')
    expect(typeof logged.latency_ms).toBe('number')
    const serialized = JSON.stringify(logged)
    expect(serialized).not.toContain('pii@example.test')
    expect(serialized).not.toContain('12345678900')
    expect(serialized).not.toContain('Fulano de Tal')
  })
})

describe('T16 — wrangler.toml sem segredos', () => {
  it('whenVars_thenSemTokenSemServiceRoleSemUrlReal', () => {
    const varsStart = WRANGLER_SOURCE.indexOf('[vars]')
    expect(varsStart).toBeGreaterThan(-1)
    const vars = WRANGLER_SOURCE.slice(varsStart)
    expect(vars).not.toContain('ASAAS_WEBHOOK_TOKEN')
    expect(vars).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect(vars).not.toMatch(/https?:\/\//)
    expect(WRANGLER_SOURCE).not.toContain('ASAAS_WEBHOOK_TOKEN')
    expect(WRANGLER_SOURCE).not.toContain('SUPABASE_SERVICE_ROLE_KEY')
    expect(WRANGLER_SOURCE).not.toMatch(/https?:\/\//)
  })

  it('whenConfig_thenQueueDlqECronsDeclarados', () => {
    expect(WRANGLER_SOURCE).toContain('binding = "PSP_QUEUE"')
    expect(WRANGLER_SOURCE).toContain('queue = "asaas-psp-events"')
    expect(WRANGLER_SOURCE).toContain('dead_letter_queue = "asaas-psp-events-dlq"')
    expect(WRANGLER_SOURCE).toContain('"*/5 * * * *"')
    expect(WRANGLER_SOURCE).toContain('"0 6 * * *"')
    expect(WRANGLER_SOURCE).toContain('main = "src/index.js"')
  })

  it('whenObservability_thenEnabledComLogsPersistidos', () => {
    // Sem `[observability]` os `console.log` não persistem (só `wrangler tail`
    // ao vivo) e a trilha de REQ-41/A8 morre no stdout (Adendo A9).
    expect(WRANGLER_SOURCE).toMatch(/\[observability\]\s*\n\s*enabled\s*=\s*true/)
    expect(WRANGLER_SOURCE).toMatch(/\[observability\.logs\]\s*\n\s*enabled\s*=\s*true/)
  })
})
