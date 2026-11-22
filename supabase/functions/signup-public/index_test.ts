// Deno tests `signup-public` — ADR-001 / SIGN-02..04, SIGN-12..13 (TDD FIRST).
// Roda offline: `npm run test:edge` (shim Deno.test → node:test) ou
// `deno test --allow-all supabase/functions/signup-public/index_test.ts`.
// Nenhuma rede: clientes GoTrue/Postgres são injetados em ./core.ts.
//
// Contrato congelado: 201 {ok:true,message} · 400 cadastro-invalido ·
// 429 muitas-tentativas + Retry-After · 500 cadastro-falhou. Sem user_id/
// tenant_id/existência de e-mail no corpo; log só request_id+route+ok.

import {
  allowedOrigin,
  clientIp,
  clientKeys,
  handleSignup,
  parseAllowedOrigins,
  realSignUpUserId,
  throttleSlot,
  tracePayload,
} from './core.ts'
import type {
  ProvisionArgs,
  SignupInput,
  SignupAuditEvent,
  SignupContext,
  SignupDeps,
} from './core.ts'

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg)
}
function assertEq<T>(got: T, want: T, msg: string): void {
  if (got !== want) {
    throw new Error(`${msg} (got ${JSON.stringify(got)}, want ${JSON.stringify(want)})`)
  }
}

const USER_ID = '22222222-2222-4222-8222-222222222222'
const TENANT_ID = '33333333-3333-4333-8333-333333333333'
const REQUEST_ID = '11111111-1111-4111-8111-111111111111'
const APP_URL = 'http://127.0.0.1:5173'

function headerOf(values: Record<string, string>): (name: string) => string | null {
  return (name: string) => values[name.toLowerCase()] ?? null
}

function makeCtx(overrides: Partial<SignupContext> = {}): SignupContext {
  return {
    requestId: REQUEST_ID,
    route: 'POST /functions/v1/signup-public',
    appUrl: APP_URL,
    header: () => null,
    ...overrides,
  }
}

interface Calls {
  resolve: string[]
  signUps: SignupInput[]
  provisions: ProvisionArgs[]
  audits: Array<{ event: SignupAuditEvent; userId: string | null }>
  deletes: string[]
  alerts: number
}

function makeDeps(overrides: Partial<SignupDeps> = {}): { deps: SignupDeps; calls: Calls } {
  const calls: Calls = {
    resolve: [], signUps: [], provisions: [], audits: [], deletes: [], alerts: 0,
  }
  const deps: SignupDeps = {
    now: () => 1_000_000,
    throttleState: new Map<string, number[]>(),
    resolveInvitedUser: async (email: string) => {
      calls.resolve.push(email)
      return { userId: null, error: null }
    },
    signUp: async (input: SignupInput) => {
      calls.signUps.push(input)
      return { userId: USER_ID, error: null }
    },
    provision: async (args: ProvisionArgs) => {
      calls.provisions.push(args)
      return { tenantId: TENANT_ID, error: null }
    },
    recordAudit: async (event: SignupAuditEvent, userId: string | null = null) => {
      calls.audits.push({ event, userId })
      return { error: null }
    },
    deleteUser: async (userId: string) => {
      calls.deletes.push(userId)
      return { error: null }
    },
    orphanAlert: () => { calls.alerts += 1 },
    ...overrides,
  }
  return { deps, calls }
}

function validBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    email: 'novo@example.com',
    password: 'senhaSegura123',
    kind: 'pf',
    document: '77100000106',
    razaoSocial: 'Signup 0101',
    plano: 'full',
    ...overrides,
  }
}

// ============================================================================
// CORS fail-closed, IP, chaves e log (SIGN-02)
// ============================================================================

Deno.test('whenAllowedOrigin_thenEchoesExactOrigin', () => {
  assertEq<string | null>(allowedOrigin(APP_URL, `${APP_URL},http://localhost:5173`, APP_URL), APP_URL,
    'origem da allowlist deve ser ecoada')
  assertEq<string | null>(allowedOrigin('http://localhost:5173', APP_URL, 'http://localhost:5173'), 'http://localhost:5173',
    'alias configurado deve ser aceito')
})

Deno.test('whenUnknownOrWildcardOrigin_thenNullFailClosed', () => {
  assertEq<string | null>(allowedOrigin('https://evil.test', APP_URL, '*'), null,
    'curinga nunca autoriza origem arbitrária')
  assertEq<string | null>(allowedOrigin('', APP_URL, APP_URL), null,
    'Origin vazia não é confiável')
  const parsed = parseAllowedOrigins(APP_URL, `*,null,${APP_URL},,NULL`)
  assertEq(parsed.length, 1, 'parse descarta *, null, vazios e duplicatas')
})

Deno.test('whenClientIpHeaders_thenForwardedRealIpUnknown', () => {
  assertEq(clientIp(headerOf({ 'x-forwarded-for': '203.0.113.7, 10.0.0.1' })), '203.0.113.7',
    'primeiro IP de x-forwarded-for')
  assertEq(clientIp(headerOf({ 'x-real-ip': '198.51.100.4' })), '198.51.100.4',
    'fallback para x-real-ip')
  assertEq(clientIp(headerOf({})), 'unknown', 'sem headers ⇒ unknown')
})

Deno.test('whenClientKeys_thenSignupUsesPublishableAndRpcUsesService', () => {
  const keys = clientKeys({ anonKey: 'anon-key', serviceKey: 'service-key' })
  assertEq(keys.signupKey, 'anon-key', 'signUp usa chave publicável')
  assertEq(keys.privilegedKey, 'service-key', 'RPC/compensação usam service_role')
})

Deno.test('whenTracePayload_thenOnlyRequestIdRouteOk', () => {
  const log = tracePayload(REQUEST_ID, 'POST /functions/v1/signup-public', true)
  assertEq(Object.keys(log).sort().join(','), 'ok,request_id,route', 'log só 3 chaves')
  const raw = JSON.stringify(log)
  assert(!raw.includes('@') && !raw.includes('senha') && !raw.includes('77100000106') && !raw.includes('token'),
    'sem PII no log')
})

// ============================================================================
// Contrato de body e anti-enumeração (SIGN-03)
// ============================================================================

Deno.test('whenValidBodyWithPlano_then201AndRedirectPreservesPlano', async () => {
  const { deps, calls } = makeDeps()
  const res = await handleSignup(validBody(), makeCtx(), deps)
  assertEq(res.status, 201, 'body válido ⇒ 201')
  const body = res.body as { ok?: unknown; message?: unknown }
  assertEq(body.ok, true, '201 com ok=true')
  assertEq(typeof body.message, 'string', '201 com chave i18n genérica')
  assertEq(calls.signUps.length, 1, 'signUp chamado 1×')
  assertEq(calls.signUps[0].redirectTo, `${APP_URL}/auth/confirm?plano=full`, '?plano= preservado no redirect')
  assert(!('email_confirm' in calls.signUps[0]), ' signsUp sem email_confirm')
  assertEq(calls.provisions.length, 1, 'RPC chamada 1×')
  assert(!('user_id' in body) && !('tenant_id' in body), '201 sem ids')
})

Deno.test('whenPasswordOutOfRange_then400SingleGenericLabel', async () => {
  for (const password of ['curta', 'x'.repeat(73), 'é'.repeat(37)]) {
    const { deps, calls } = makeDeps()
    const res = await handleSignup(validBody({ password }), makeCtx(), deps)
    assertEq(res.status, 400, `senha ${password.length} chars ⇒ 400`)
    assertEq((res.body as { error: string }).error, 'cadastro-invalido', 'rótulo único')
    assertEq(calls.resolve.length, 0, 'inválido não chega ao throttle-resolve')
  }
})

Deno.test('whenInvalidKindOrDocument_then400WithoutDetail', async () => {
  for (const over of [{ kind: 'xx' }, { document: '123' }, { document: '7710000010a' }, { razaoSocial: '' }, { email: 'sem-arroba' }]) {
    const { deps } = makeDeps()
    const res = await handleSignup(validBody(over), makeCtx(), deps)
    assertEq(res.status, 400, `payload ${JSON.stringify(over)} ⇒ 400`)
    const raw = JSON.stringify(res.body)
    assert(!raw.includes('dígito') && !raw.includes('cpf') && !raw.includes('digito'), '400 sem detalhe')
    assertEq((res.body as { error: string }).error, 'cadastro-invalido', 'rótulo único')
  }
})

Deno.test('whenClientSuppliesIdentity_then400Discarded', async () => {
  const { deps, calls } = makeDeps()
  const res = await handleSignup(validBody({ user_id: USER_ID, tenant_id: TENANT_ID }), makeCtx(), deps)
  assertEq(res.status, 400, 'identidade vinda do cliente ⇒ 400')
  assertEq(calls.resolve.length, 0, 'nenhuma identidade do cliente é processada')
})

// ============================================================================
// Ordem congelada e resolução de convite (SIGN-02 / SIGN-16)
// ============================================================================

Deno.test('whenNewSignup_thenOrderResolveSignUpProvision', async () => {
  const order: string[] = []
  const { deps } = makeDeps({
    resolveInvitedUser: async (email) => { order.push(`resolve:${email}`); return { userId: null, error: null } },
    signUp: async (input) => { order.push('signUp'); return { userId: USER_ID, error: null } },
    provision: async () => { order.push('provision'); return { tenantId: TENANT_ID, error: null } },
  })
  await handleSignup(validBody(), makeCtx(), deps)
  assertEq(order.join(' > '), 'resolve:novo@example.com > signUp > provision', 'ordem congelada')
})

Deno.test('whenExistingEmail_then201IdenticalWithoutSignUp', async () => {
  const { deps, calls } = makeDeps({
    resolveInvitedUser: async () => ({ userId: USER_ID, error: null }),
  })
  const res = await handleSignup(validBody(), makeCtx(), deps)
  assertEq(res.status, 201, 'e-mail existente ⇒ 201 genérico')
  assertEq(calls.signUps.length, 0, 'sem novo signUp')
  assertEq(calls.provisions.length, 0, 'sem provisionamento')
  assertEq(calls.deletes.length, 0, 'não apaga conta pré-existente')
})

Deno.test('whenSignUpError_then201GenericNoDelete', async () => {
  // Erro do GoTrue (inclusive duplicata) NÃO revela estado: sem userId confiável
  // não se chama deleteUser (evita apagar conta de terceiro).
  const { deps, calls } = makeDeps({
    signUp: async () => ({ userId: null, error: { message: 'User already registered' } }),
  })
  const res = await handleSignup(validBody(), makeCtx(), deps)
  assertEq(res.status, 201, 'erro de signUp ⇒ 201 genérico')
  assertEq(calls.deletes.length, 0, 'sem userId não há compensação')
  assertEq(calls.provisions.length, 0, 'não provisiona sem identidade')
})

// ============================================================================
// 🟡-1: 201 byte-idêntico nos 3 cenários + compensação silenciosa
// ============================================================================

Deno.test('whenDocumentCollision_then201ByteIdenticalSilentCompensation', async () => {
  const fresh = await handleSignup(validBody(), makeCtx(), makeDeps().deps)
  const dup = await handleSignup(validBody(), makeCtx(), makeDeps({
    resolveInvitedUser: async () => ({ userId: USER_ID, error: null }),
  }).deps)
  const collide = makeDeps({
    provision: async () => ({ error: { code: 'tenant-document-duplicate' } }),
  })
  const col = await handleSignup(validBody({ email: 'outro@example.com' }), makeCtx(), collide.deps)

  assertEq(col.status, 201, 'colisão de documento ⇒ 201, nunca 500')
  assertEq(JSON.stringify(col.body), JSON.stringify(fresh.body), '201 colisão == 201 conta nova (byte a byte)')
  assertEq(JSON.stringify(dup.body), JSON.stringify(fresh.body), '201 e-mail duplicado == 201 conta nova')
  assertEq(collide.calls.deletes.length, 1, 'compensação silenciosa: deleteUser 1×')
  assertEq(collide.calls.deletes[0], USER_ID, 'apaga só o usuário criado nesta chamada')
  assertEq(collide.calls.audits.length, 1, '1 linha de auditoria')
  assertEq(collide.calls.audits[0].event, 'signup-public-compensated', 'evento compensado')
  const raw = JSON.stringify(col.body)
  assert(!raw.includes('tenant-document-duplicate') && !raw.includes('documento'), 'sem rótulo interno no corpo')
})

Deno.test('whenDbValidationFails_then400GenericWithCompensation', async () => {
  const { deps, calls } = makeDeps({
    provision: async () => ({ error: { code: 'P0001', message: 'tenant-document-invalid' } }),
  })
  const res = await handleSignup(validBody(), makeCtx(), deps)
  assertEq(res.status, 400, 'erro de validação do banco ⇒ 400 genérico')
  assertEq((res.body as { error: string }).error, 'cadastro-invalido', 'sem rótulo do banco')
  assertEq(calls.deletes.length, 1, 'compensa identidade recém-criada')
  assertEq(calls.audits.length, 1, 'auditoria compensada 1×')
})

// ============================================================================
// Gate 5 / 🟡-3: compensação e órfão explícito
// ============================================================================

Deno.test('whenProvisionFails_then500GenericDeleteOnceAuditOnce', async () => {
  const { deps, calls } = makeDeps({
    provision: async () => ({ error: { code: 'P0001', message: 'db-down' } }),
  })
  const res = await handleSignup(validBody(), makeCtx(), deps)
  assertEq(res.status, 500, 'falha da RPC ⇒ 500')
  assertEq((res.body as { error: string }).error, 'cadastro-falhou', 'rótulo genérico')
  assertEq(calls.deletes.length, 1, 'deleteUser exatamente 1×')
  assertEq(calls.audits.length, 1, '1 signup-public-compensated')
  assertEq(calls.audits[0].event, 'signup-public-compensated', 'evento correto')
  assert(!JSON.stringify(res.body).includes('db-down'), 'sem detalhe interno')
})

Deno.test('whenDeleteUserFails_thenOrphanAlertRegisteredExplicitly', async () => {
  // R1: NÃO assertar zero órfão. A falha do deleteUser é registrada como
  // órfão residual com alerta; retry idempotente por e-mail é feito na
  // próxima chamada (resolveInvitedUser).
  let deletes = 0
  const { deps, calls } = makeDeps({
    provision: async () => ({ error: { message: 'db-down' } }),
    deleteUser: async () => {
      deletes += 1
      return { error: { message: 'delete-failed' } }
    },
  })
  const res = await handleSignup(validBody(), makeCtx(), deps)
  assertEq(res.status, 500, 'falha da compensação segue 500 genérico')
  assertEq(deletes, 1, 'deleteUser tentado 1×')
  assertEq(calls.alerts, 1, 'R1: alerta de órfão disparado explicitamente')
  assertEq(calls.audits.length, 1, 'órfão registrado em admin_audit')

  // retry idempotente por e-mail: conta resolvida ⇒ 201, sem novo delete.
  const retry = makeDeps({ resolveInvitedUser: async () => ({ userId: USER_ID, error: null }) })
  const again = await handleSignup(validBody(), makeCtx(), retry.deps)
  assertEq(again.status, 201, 'retry com mesmo e-mail ⇒ 201 genérico (idempotente)')
  assertEq(retry.calls.deletes.length, 0, 'retry não apaga tenant de outro signup')
})

// ============================================================================
// 🟡-2 / gate 4: throttle 10/min por IP, 0 escrita acima do limite
// ============================================================================

Deno.test('whenTenRequestsInWindow_thenAllPass', async () => {
  const ctx = makeCtx({ header: headerOf({ 'x-forwarded-for': '203.0.113.7' }) })
  const { deps, calls } = makeDeps()
  for (let i = 0; i < 10; i += 1) {
    const res = await handleSignup(validBody(), ctx, deps)
    assertEq(res.status, 201, `requisição ${i + 1} permitida`)
  }
  assertEq(calls.signUps.length, 10, '10 signUps')
  assertEq(calls.provisions.length, 10, '10 provisionamentos')
  assertEq(calls.audits.filter((a) => a.event === 'signup-public-throttled').length, 0, '0 throttle')
})

Deno.test('whenEleventhRequest_then429RetryAfterZeroWritesOneAudit', async () => {
  const ctx = makeCtx({ header: headerOf({ 'x-forwarded-for': '203.0.113.9' }) })
  const { deps, calls } = makeDeps()
  for (let i = 0; i < 10; i += 1) await handleSignup(validBody(), ctx, deps)
  const res = await handleSignup(validBody(), ctx, deps)

  assertEq(res.status, 429, '11ª ⇒ 429')
  assertEq((res.body as { error: string }).error, 'muitas-tentativas', 'rótulo do 429')
  const retryAfter = res.headers?.['Retry-After']
  assert(typeof retryAfter === 'string' && /^[0-9]+$/.test(retryAfter) && Number(retryAfter) >= 1,
    'Retry-After numérico ≥ 1')
  assertEq(calls.resolve.length, 10, '0 resolução acima do limite')
  assertEq(calls.signUps.length, 10, '0 INSERT em auth.users acima do limite')
  assertEq(calls.provisions.length, 10, '0 escrita de domínio acima do limite')
  assertEq(calls.audits.filter((a) => a.event === 'signup-public-throttled').length, 1, '1 auditoria throttled')
})

Deno.test('whenThrottleSlotExpires_thenWindowReopens', () => {
  const state = new Map<string, number[]>()
  const t0 = 1_000_000
  for (let i = 0; i < 10; i += 1) assertEq(throttleSlot(state, 'ip-a', t0 + i), 0, 'slot aberto')
  assert(throttleSlot(state, 'ip-a', t0 + 10) > 0, '11º negado')
  assertEq(throttleSlot(state, 'ip-a', t0 + 60_001), 0, 'janela 60s reabre')
  assertEq(throttleSlot(state, 'ip-b', t0 + 10), 0, 'outro IP não é afetado')
})

// ============================================================================
// 🟡-1 (re-review): usuário obfuscado do GoTrue e janela de corrida.
// `admin_resolve_invited_user` filtra deleted_at IS NULL; signUp pode devolver
// um user sanitizado (identities: []) para e-mail confirmado/duplicado.
// Nunca provisionar nem apagar esse id — ele pertence a terceiro.
// Fonte: https://supabase.com/docs/reference/javascript/auth-signup (2026-11-21)
// e https://github.com/supabase/auth-js/issues/513 (2026-11-21).
// ============================================================================

Deno.test('whenObfuscatedSignUpUser_then201ByteIdenticalNoProvisionNoDelete', async () => {
  const fresh = await handleSignup(validBody(), makeCtx(), makeDeps().deps)

  // Mesma função usada por index.ts em deps.signUp sobre `data` do GoTrue.
  const raw = { user: { id: USER_ID, identities: [] } }
  assertEq(realSignUpUserId(raw), null, 'user obfuscado não é id confiável')
  assertEq(realSignUpUserId({ user: { id: USER_ID, identities: [{ provider: 'email' }] } }), USER_ID,
    'user real com identity é aceito')
  assertEq(realSignUpUserId({ user: { identities: [{ provider: 'email' }] } }), null,
    'sem id não há identidade materializada')

  const { deps, calls } = makeDeps({
    signUp: async () => ({ userId: realSignUpUserId(raw), error: null }),
  })
  const res = await handleSignup(validBody({ email: 'obfuscado@example.com' }), makeCtx(), deps)
  assertEq(res.status, 201, 'obfuscado ⇒ 201 genérico')
  assertEq(JSON.stringify(res.body), JSON.stringify(fresh.body), '201 byte-idêntico ao de conta nova')
  assertEq(calls.provisions.length, 0, '0 provisionamento')
  assertEq(calls.deletes.length, 0, '0 compensação (nunca apagar id de terceiro)')
  assertEq(calls.audits.length, 0, '0 auditoria')
})

Deno.test('whenConcurrentDuplicateSignUps_thenAtMostOneProvision', async () => {
  // Contraprova: resolve vazio para dois signUps do mesmo e-mail; o GoTrue
  // obfusca o segundo. No máximo 1 provisionamento; o outro 201 sem escrita.
  const { deps, calls } = makeDeps({
    signUp: async (input) => {
      const raw = input.email === 'race@example.com'
        ? { user: { id: USER_ID, identities: [] } }
        : { user: { id: USER_ID, identities: [{ provider: 'email' }] } }
      return { userId: realSignUpUserId(raw), error: null }
    },
  })
  const ctx = makeCtx()
  const [first, second] = await Promise.all([
    handleSignup(validBody(), ctx, deps),
    handleSignup(validBody({ email: 'race@example.com' }), ctx, deps),
  ])
  assertEq(calls.provisions.length, 1, 'no máximo 1 provisionamento na corrida')
  assertEq(first.status, 201, '1º ⇒ 201')
  assertEq(second.status, 201, '2º obfuscado ⇒ 201')
  assertEq(JSON.stringify(first.body), JSON.stringify(second.body), 'corpos idênticos')
  assertEq(calls.deletes.length, 0, 'corrida não apaga conta de terceiro')
})

// ============================================================================
// SIGN-16 — convite administrativo paralelo (0077–0080 intacto).
// `admin_resolve_invited_user` corre ANTES do signUp; convite pendente ⇒
// 201 genérico (nunca 409 que enumere e-mail). Reuso por (owner, documento)
// é provado em SQL 0104; aqui a borda só encaminha a chave natural.
// ============================================================================

Deno.test('whenPendingInviteResolved_then201GenericNoSignUpNoProvisionNo409', async () => {
  const fresh = await handleSignup(validBody(), makeCtx(), makeDeps().deps)
  let resolvedEmail = ''
  const { deps, calls } = makeDeps({
    resolveInvitedUser: async (email: string) => {
      resolvedEmail = email
      return { userId: USER_ID, error: null }
    },
  })
  const res = await handleSignup(validBody({ email: 'convite-pendente@example.com' }), makeCtx(), deps)
  assertEq(resolvedEmail, 'convite-pendente@example.com', 'resolve recebe o e-mail do body')
  assertEq(res.status, 201, 'convite pendente ⇒ 201, nunca 409')
  assertEq(JSON.stringify(res.body), JSON.stringify(fresh.body), '201 idêntico ao de conta nova')
  assertEq(calls.signUps.length, 0, '0 novo usuário')
  assertEq(calls.provisions.length, 0, '0 provisionamento duplicado')
  assertEq(calls.deletes.length, 0, 'convite não é apagado')
  assertEq(calls.audits.length, 0, 'convite não gera trilha de signup')
  assert(!JSON.stringify(res.body).includes('convite'), '201 não revela estado do convite')
})

Deno.test('whenInviteCollisionWithOwnerDocument_thenReuseKeyNoDuplicateOwner', async () => {
  // Mesmo dono + documento: a RPC (0104) devolve o tenant existente com
  // reason='signup-reused' e zero INSERT. A borda não cria membro owner
  // duplicado nem apaga o tenant do convite.
  let provisionArgs: ProvisionArgs | null = null
  const { deps: reused, calls: reuseCalls } = makeDeps({
    provision: async (args: ProvisionArgs) => {
      provisionArgs = args
      return { tenantId: TENANT_ID, error: null }
    },
  })
  const reusedRes = await handleSignup(validBody(), makeCtx(), reused)
  assertEq(reusedRes.status, 201, 'reuso ⇒ 201')
  assert(provisionArgs !== null, 'uma única RPC de provisionamento')
  assertEq(provisionArgs?.ownerUserId, USER_ID, 'dono vem do Auth, nunca do body')
  assertEq(provisionArgs?.document, '77100000106', 'documento normalizado na chave natural')
  assertEq(reuseCalls.deletes.length, 0, 'reuso nunca apaga o owner existente')

  // Convidado já resolvido: nem RPC é chamada (o tenant do convite permanece).
  const { deps: invited, calls: inviteCalls } = makeDeps({
    resolveInvitedUser: async () => ({ userId: USER_ID, error: null }),
  })
  const invitedRes = await handleSignup(validBody({ email: 'convidado@example.com' }), makeCtx(), invited)
  assertEq(invitedRes.status, 201, 'convite + documento colidentes ⇒ 201 genérico')
  assertEq(inviteCalls.provisions.length, 0, '0 escrita no caminho do convite')
  assertEq(JSON.stringify(invitedRes.body), JSON.stringify(reusedRes.body), 'nenhum oráculo de colisão')
})

Deno.test('whenResolveFails_then500GenericWithoutEnumeration', async () => {
  const { deps, calls } = makeDeps({
    resolveInvitedUser: async () => ({ userId: null, error: { message: 'relation does not exist' } }),
  })
  const res = await handleSignup(validBody(), makeCtx(), deps)
  assertEq(res.status, 500, 'falha do resolve ⇒ 500')
  assertEq((res.body as { error: string }).error, 'cadastro-falhou', 'rótulo genérico')
  assertEq(calls.signUps.length, 0, 'sem identidade criada quando o resolve falha')
  assert(!JSON.stringify(res.body).includes('relation'), 'sem detalhe interno')
})
