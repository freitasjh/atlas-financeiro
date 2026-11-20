// @vitest-environment node
/**
 * T17/T18 — camada que toca o runtime (index.js): `createRpc` e o cron.
 *
 * `createRpc` é onde o `service_role` vive; o cron é o único consumidor do
 * retorno de `drain`/`scrub` (REQ-44, Adendo A8) e o orçamento de timeout dele
 * é distinto do de admissão (Adendo A10).
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker, { CRON_RPC_TIMEOUT_MS, createRpc, runScheduled, SCRUB_CRON } from './index.js'
import { RPC_TIMEOUT_MS } from './core.js'

const ENV = {
  SUPABASE_URL: 'https://ref.supabase.test/',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-test-placeholder',
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

describe('T17 — createRpc (service_role só no header da RPC)', () => {
  it('whenRpcChamada_thenUrlHeadersBodyESignal', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ stored: true, outcome: 'stored' }))
    vi.stubGlobal('fetch', fetchMock)
    const rpc = createRpc(ENV)

    const result = await rpc('ingest_psp_event', { p_event_id: 'evt_1' })

    expect(result).toEqual({ status: 200, data: { stored: true, outcome: 'stored' } })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ref.supabase.test/rest/v1/rpc/ingest_psp_event')
    expect(init.method).toBe('POST')
    expect(init.headers.apikey).toBe(ENV.SUPABASE_SERVICE_ROLE_KEY)
    expect(init.headers.Authorization).toBe(`Bearer ${ENV.SUPABASE_SERVICE_ROLE_KEY}`)
    expect(init.headers['Content-Type']).toBe('application/json')
    // Conjunto exato: nenhum header extra (ex.: um segredo adicional) passa.
    expect(Object.keys(init.headers).sort()).toEqual(['Authorization', 'Content-Type', 'apikey'])
    expect(init.body).toBe(JSON.stringify({ p_event_id: 'evt_1' }))
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it('whenSemTimeoutExplicito_thenUsaOrcamentoDeAdmissao', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})))
    const rpc = createRpc(ENV)

    await rpc('ingest_psp_event', {})

    expect(timeoutSpy).toHaveBeenCalledWith(RPC_TIMEOUT_MS)
  })

  it('whenTimeoutExplicito_thenRespeitado', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse({})))
    const rpc = createRpc(ENV)

    await rpc('scrub_psp_events', {}, { timeoutMs: CRON_RPC_TIMEOUT_MS })

    expect(timeoutSpy).toHaveBeenCalledWith(CRON_RPC_TIMEOUT_MS)
  })

  it('whenCorpoNaoJson_thenDataNulo', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nao-json', { status: 502 })))
    const rpc = createRpc(ENV)

    expect(await rpc('drain_psp_events', {})).toEqual({ status: 502, data: null })
  })
})

describe('T18 — cron: orçamento próprio e log com o retorno da RPC (A8/A10)', () => {
  it('whenDrainScheduled_thenTimeoutDeCronELogComContadores', async () => {
    const data = { applied: 2, noop: 1, rejected: 0, failed: 0, pending: 3 }
    const rpc = vi.fn(async () => ({ status: 200, data }))
    const log = vi.fn()

    await runScheduled({ cron: '*/5 * * * *' }, { rpc, log })

    expect(rpc).toHaveBeenCalledWith('drain_psp_events', {}, { timeoutMs: CRON_RPC_TIMEOUT_MS })
    expect(CRON_RPC_TIMEOUT_MS).toBeGreaterThan(RPC_TIMEOUT_MS)
    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toEqual({
      scheduled: 'drain_psp_events',
      status: 200,
      result: data,
    })
  })

  it('whenScrubScheduled_thenLogComScrubbedERemainingOverdue', async () => {
    const data = { scrubbed: 500, remaining_overdue: 12 }
    const rpc = vi.fn(async () => ({ status: 200, data }))
    const log = vi.fn()

    await runScheduled({ cron: SCRUB_CRON }, { rpc, log })

    expect(rpc).toHaveBeenCalledWith('scrub_psp_events', {}, { timeoutMs: CRON_RPC_TIMEOUT_MS })
    expect(log.mock.calls[0][0]).toEqual({
      scheduled: 'scrub_psp_events',
      status: 200,
      result: data,
    })
  })

  it('whenRpcFalha_thenLogDeErroSemResult', async () => {
    const rpc = vi.fn(async () => {
      throw new Error('timeout')
    })
    const log = vi.fn()

    await runScheduled({ cron: '*/5 * * * *' }, { rpc, log })

    expect(log).toHaveBeenCalledTimes(1)
    expect(log.mock.calls[0][0]).toEqual({ scheduled: 'drain_psp_events', status: 'error' })
  })
})

describe('T19 — consumer da fila: mesmo orçamento do cron (A10)', () => {
  it('whenQueueDrena_thenUsaOrcamentoDeCronEAck', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const fetchMock = vi.fn(async () => jsonResponse({ applied: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const ack = vi.fn()
    const retry = vi.fn()

    await worker.queue({ messages: [{ body: { eventId: 'evt_1' }, ack, retry }] }, ENV)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    // Nome e args da RPC: sem isto a mutação `DRAIN_RPC → SCRUB_RPC` sobrevivia
    // (o teste só olhava o timeout e o `ack`).
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://ref.supabase.test/rest/v1/rpc/drain_psp_events')
    expect(JSON.parse(init.body)).toEqual({ p_event_id: 'evt_1' })
    // `drain` na fila herda o orçamento de 30 s, não os 5 s de admissão:
    // abort no meio do `drain` faz rollback e o retry nunca avança.
    expect(timeoutSpy).toHaveBeenCalledWith(CRON_RPC_TIMEOUT_MS)
    expect(timeoutSpy).not.toHaveBeenCalledWith(RPC_TIMEOUT_MS)
    expect(ack).toHaveBeenCalledTimes(1)
    expect(retry).not.toHaveBeenCalled()
  })
})
