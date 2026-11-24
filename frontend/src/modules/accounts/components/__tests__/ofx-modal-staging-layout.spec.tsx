// @vitest-environment happy-dom
// P1.3 — picker nunca alarga: com ou sem arquivo, sm:max-w-[440px] fixo
// (staging migrou para a página /contas/importar; sem scroll interno de tabela).
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { ImportOfxModal } from '../ImportOfxModal'
import { BB_FIXTURE } from '@/lib/ofx/__tests__/fixtures'
import type { AccountViewItem } from '../../model/view-model'

const ACCOUNTS: AccountViewItem[] = [
  {
    id: 'acc-1', nickname: 'Conta Um', institution: 'itau', type: 'checking',
    agency: '0001', accountNumber: '12345', accountDigit: '0',
    currentBalanceCents: 100000, reconciledBalanceCents: 100000,
    blockedBalanceCents: 0, isDefault: false, connectionStatus: 'connected',
  },
]

function renderPicker() {
  return render(
    <I18nextProvider i18n={i18n}>
      <ImportOfxModal open onOpenChange={() => {}} accounts={ACCOUNTS} initialAccountId="acc-1" />
    </I18nextProvider>,
  )
}

function dialogContent(): HTMLElement {
  const dlg = screen.getByRole('dialog')
  return (dlg.querySelector('[data-slot="dialog-content"]') as HTMLElement) ?? dlg
}

afterEach(() => {
  cleanup()
})

describe('whenPickerEmpty_thenNarrowDialog', () => {
  it('estado vazio mantém sm:max-w-[440px]', () => {
    renderPicker()
    const content = dialogContent()
    expect(content.className).toContain('sm:max-w-[440px]')
    expect(content.className).not.toContain('sm:max-w-xl')
    expect(content.className).not.toContain('sm:max-w-2xl')
  })
})

describe('whenPickerHasFile_thenStillNarrowWithoutStagingScroll', () => {
  it('com arquivo continua estreito e sem scroll de tabela', async () => {
    renderPicker()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([BB_FIXTURE], 'bb.ofx', { type: 'application/x-ofx' })] } })
    await screen.findByText('bb.ofx')
    const content = dialogContent()
    expect(content.className).toContain('sm:max-w-[440px]')
    expect(document.querySelector('[data-testid="staging-table-scroll"]')).toBeNull()
  })
})
