// Mapa de tokens de marca das instituições financeiras (C-S7).
// Fonte única de classes semânticas: nenhum hex solto em componente.
// O esquema é sempre "fundo 10% + texto 600/400 + borda 30%" — mesma
// receita documentada em DESIGN.md §2.2, aplicada à identidade do banco.
import type { InstitutionCode } from './view-model'

export const BRAND_TOKEN_FALLBACK = 'border-border/80 bg-muted/40 text-muted-foreground border'

export const BRAND_TOKENS: Record<InstitutionCode, string> = {
  itau: 'bg-orange-500/10 text-orange-600 dark:text-orange-400 border-orange-500/30',
  bradesco: 'bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/30',
  santander: 'bg-red-600/10 text-red-600 dark:text-red-400 border-red-600/30',
  bb: 'bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/30',
  nubank: 'bg-purple-500/10 text-purple-600 dark:text-purple-400 border-purple-500/30',
  inter: 'bg-orange-600/10 text-orange-600 dark:text-orange-400 border-orange-600/30',
  btg: 'bg-blue-600/10 text-blue-600 dark:text-blue-400 border-blue-600/30',
  caixa: 'bg-sky-500/10 text-sky-600 dark:text-sky-400 border-sky-600/30',
  cora: 'bg-pink-500/10 text-pink-600 dark:text-pink-400 border-pink-500/30',
  mercadopago: 'bg-cyan-500/10 text-cyan-600 dark:text-cyan-400 border-cyan-500/30',
  stripe: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400 border-indigo-500/30',
  cash: 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/30',
  other: BRAND_TOKEN_FALLBACK,
}

/** Resolve o token de marca; instituição desconhecida cai no neutro. */
export function brandTokenFor(code: InstitutionCode): string {
  return BRAND_TOKENS[code] ?? BRAND_TOKEN_FALLBACK
}
