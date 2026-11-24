// MOD-01 (SPEC §2) — faixas do gauge do limite, puro. Dinheiro em BIGINT cents;
// bps é unidade de display (0..10000+), nunca float de dinheiro.

export type LimitBand = 'ok' | 'warning' | 'critical' | 'over'
export type LimitState = 'ready' | 'loading' | 'unavailable' | 'no-limit'

function assertInteger(value: number, name: string): void {
  if (!Number.isInteger(value)) throw new Error(`${name} deve ser inteiro em cents (sem float)`)
}

// unavailable quando a agregação é inválida (NaN/Infinity); no-limit quando o
// cartão não tem limite definido. Float de dinheiro nunca passa.
export function limitBps(usedCents: number, limitCents: number): number | null {
  if (!Number.isFinite(usedCents) || !Number.isFinite(limitCents)) return null
  assertInteger(usedCents, 'usedCents')
  assertInteger(limitCents, 'limitCents')
  if (limitCents === 0) return null
  return Math.round((usedCents * 10000) / limitCents)
}

// `over` tem precedência por centavos: 1 centavo acima do limite é over mesmo
// que o arredondamento de bps dê 10000 (limite alto).
export function limitBand(usedCents: number, limitCents: number): LimitBand | null {
  const bps = limitBps(usedCents, limitCents)
  if (bps === null) return null
  if (usedCents > limitCents) return 'over'
  if (bps < 6000) return 'ok'
  if (bps <= 8500) return 'warning'
  return 'critical'
}

// Percentual de exibição: NÃO é clampado (112% aparece). O clamp 0..100 fica
// para aria-valuenow/largura do fill na camada visual.
export function usedPercent(bps: number): number {
  if (!Number.isFinite(bps)) throw new Error('bps deve ser finito')
  return bps / 100
}

// O3-04 — fórmula única do passivo da fatura (SSoT). `outstandingCents` valida
// e lança (entrada já confiável); `outstandingCentsOrNull` devolve null para a
// linha inválida que o chamador descarta. Sem float, sem segunda fórmula.
function outstandingFrom(totalCents: number, paidCents: number): number {
  return Math.max(totalCents - paidCents, 0)
}

export function outstandingCentsOrNull(inv: {
  total_cents: number
  paid_cents?: number | null
}): number | null {
  const paid = inv.paid_cents ?? 0
  if (!Number.isInteger(inv.total_cents) || !Number.isInteger(paid)) return null
  return outstandingFrom(inv.total_cents, paid)
}

export function outstandingCents(inv: {
  total_cents: number
  paid_cents?: number | null
}): number {
  assertInteger(inv.total_cents, 'total_cents')
  const paid = inv.paid_cents ?? 0
  assertInteger(paid, 'paid_cents')
  return outstandingFrom(inv.total_cents, paid)
}

// Disponível pode ser negativo: é alerta visual, nunca bloqueio (RF03-10).
export function availableCents(limitCents: number, committedCents: number): number {
  assertInteger(limitCents, 'limitCents')
  assertInteger(committedCents, 'committedCents')
  return limitCents - committedCents
}
