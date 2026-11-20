// Mensagem honesta do guard OFX (tamanho/extensão/linhas/decode).
// Reuso único entre o picker-modal e a página /contas/importar.
import type { OfxGuardError } from '../hooks/useOfxImport'

export function ofxGuardMessage(
  t: (key: string) => string,
  code: OfxGuardError | null,
  fallback: string | null,
): string | null {
  if (code === 'too-large') return t('accounts.ofx.errorTooLarge')
  if (code === 'invalid-type') return t('accounts.ofx.errorInvalidType')
  if (code === 'too-many-lines') return t('accounts.ofx.errorTooManyLines')
  if (code === 'decode-error') return t('accounts.ofx.errorDecode')
  if (code === 'required') return t('accounts.ofx.errorRequired')
  return fallback
}
