// @vitest-environment happy-dom
// P1.3 — modal reduzido a picker-atalho (sm:max-w-[440px]): dropzone + conta +
// "Continuar para revisão" → onContinueToReview({fileText, fileName, accountId}).
// Sem staging interno, sem trava de conta, sem persistência.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { ImportOfxModal } from '../ImportOfxModal'
import { BB_FIXTURE } from '@/lib/ofx/__tests__/fixtures'
import type { AccountViewItem } from '../../model/view-model'

function account(id: string, name: string): AccountViewItem {
  return {
    id,
    nickname: name,
    institution: 'itau',
    type: 'checking',
    agency: '0001',
    accountNumber: '12345',
    accountDigit: '0',
    currentBalanceCents: 100000,
    reconciledBalanceCents: 100000,
    blockedBalanceCents: 0,
    isDefault: false,
    connectionStatus: 'connected',
  }
}

const ACCOUNTS = [account('acc-1', 'Conta Um'), account('acc-2', 'Conta Dois')]

function renderPicker(overrides: Partial<React.ComponentProps<typeof ImportOfxModal>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <ImportOfxModal open onOpenChange={() => {}} accounts={ACCOUNTS} initialAccountId="acc-1" {...overrides} />
    </I18nextProvider>,
  )
}

function dialogContent(): HTMLElement {
  const dlg = screen.getByRole('dialog')
  return (dlg.querySelector('[data-slot="dialog-content"]') as HTMLElement) ?? dlg
}

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('whenPickerOpens_thenNarrowWithoutStaging', () => {
  it('dialog estreito sm:max-w-[440px] sem tabela de staging', () => {
    renderPicker()
    expect(dialogContent().className).toContain('sm:max-w-[440px]')
    expect(screen.queryByText(i18n.t('accounts.staging.title'))).toBeNull()
  })

  it('conta nunca trava (sem staging no modal)', async () => {
    renderPicker()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([BB_FIXTURE], 'bb.ofx', { type: 'application/x-ofx' })] } })
    await screen.findByText('bb.ofx')
    // C-S4: Select do design system (Radix) — trigger segue habilitado.
    const trigger = screen.getByRole('combobox', { name: i18n.t('accounts.ofx.accountLabel') })
    expect(trigger.hasAttribute('disabled')).toBe(false)
  })
})

describe('whenPickerContinues_thenHandoffCarriesFileAndAccount', () => {
  it('continuar sem arquivo fica desabilitado (sem handoff vazio)', () => {
    renderPicker()
    const continueBtn = screen.getByRole('button', { name: i18n.t('accounts.ofx.continueToReview') })
    expect((continueBtn as HTMLButtonElement).disabled).toBe(true)
  })

  it('arquivo + conta seguem no payload (memória, sem persistir)', async () => {
    const onContinueToReview = vi.fn()
    const onOpenChange = vi.fn()
    // C-S4: a conta escolhida entra pelo initialAccountId (o Select do design
    // system é o mesmo componente da transferência, coberto por teclado lá).
    renderPicker({ onContinueToReview, onOpenChange, initialAccountId: 'acc-2' })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([BB_FIXTURE], 'bb.ofx', { type: 'application/x-ofx' })] } })
    await screen.findByText('bb.ofx')
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.continueToReview') }))
    await waitFor(() => expect(onContinueToReview).toHaveBeenCalledTimes(1))
    const payload = onContinueToReview.mock.calls[0][0] as {
      fileText: string
      fileName: string
      accountId: string
    }
    expect(payload.fileName).toBe('bb.ofx')
    expect(payload.accountId).toBe('acc-2')
    expect(payload.fileText).toContain('OFXHEADER')
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it('arquivo inválido mostra erro em role=alert sem navegar', () => {
    const onContinueToReview = vi.fn()
    renderPicker({ onContinueToReview })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['nao-ofx'], 'nota.txt', { type: 'text/plain' })] } })
    return screen.findByRole('alert').then(() => {
      expect(onContinueToReview).not.toHaveBeenCalled()
    })
  })
})
