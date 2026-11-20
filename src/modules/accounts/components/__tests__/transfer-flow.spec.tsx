// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { TransferModal } from '../TransferModal'
import { AccountsView } from '../AccountsView'
import type { AccountViewItem } from '../../model/view-model'

const toastMocks = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast: toastMocks }))

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

function renderModal(props: Partial<React.ComponentProps<typeof TransferModal>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <TransferModal
        open
        onOpenChange={() => {}}
        accounts={ACCOUNTS}
        initialSourceAccountId="acc-1"
        onExecuteTransfer={() => Promise.resolve(true)}
        {...props}
      />
    </I18nextProvider>,
  )
}

function fillValidAmount() {
  const amount = screen.getByLabelText(i18n.t('accounts.transfer.amountLabel')) as HTMLInputElement
  fireEvent.change(amount, { target: { value: '100,00' } })
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.transfer.confirm') }))
}

afterEach(() => {
  cleanup()
  toastMocks.success.mockReset()
  toastMocks.info.mockReset()
  toastMocks.error.mockReset()
})

describe('whenTransferSubmitIsInFlight_thenSecondSubmitIsBlocked', () => {
  it('anti-duplo-submit: segundo clique não re-dispara onExecuteTransfer', async () => {
    let resolveFlight!: (value: boolean) => void
    const flight = new Promise<boolean>((resolve) => {
      resolveFlight = resolve
    })
    const onExecuteTransfer = vi.fn(() => flight)
    const onOpenChange = vi.fn()
    renderModal({ onExecuteTransfer, onOpenChange })

    fillValidAmount()
    await act(async () => {
      submit()
    })
    // Botão desabilitado durante o voo.
    expect(
      (screen.getByRole('button', { name: i18n.t('accounts.transfer.confirm') }) as HTMLButtonElement).disabled,
    ).toBe(true)
    await act(async () => {
      submit()
    })
    expect(onExecuteTransfer).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFlight(true)
      await flight
    })
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenCalledWith(false)
    })
  })
})

describe('whenTransferExecutionRejects_thenModalStaysOpenWithError', () => {
  it('falha não gera unhandled: modal permanece aberto com erro e reabilita o submit', async () => {
    const onExecuteTransfer = vi.fn(() => Promise.reject(new Error('transferError')))
    const onOpenChange = vi.fn()
    renderModal({ onExecuteTransfer, onOpenChange })

    fillValidAmount()
    await act(async () => {
      submit()
    })
    await waitFor(() => {
      expect(screen.getByText(i18n.t('accounts.transferError'))).toBeTruthy()
    })
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    // Submit reabilitado após a falha.
    expect(
      (screen.getByRole('button', { name: i18n.t('accounts.transfer.confirm') }) as HTMLButtonElement).disabled,
    ).toBe(false)
  })
})

describe('whenAccountsViewTransferFails_thenNoUnhandledRejection', () => {
  it('owner retorna false: modal exibe erro inline e NÃO fecha', async () => {
    const onExecuteTransfer = vi.fn(() => Promise.resolve(false))
    // Monta a cadeia real view → modal: a view repassa o boolean sem swallow.
    render(
      <I18nextProvider i18n={i18n}>
        <AccountsView accounts={ACCOUNTS} initialViewMode="grid" onExecuteTransfer={onExecuteTransfer} />
      </I18nextProvider>,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.metrics.transfer') }))
    })
    fillValidAmount()
    await act(async () => {
      submit()
    })
    await waitFor(() => {
      expect(onExecuteTransfer).toHaveBeenCalledTimes(1)
    })
    // Modal permanece aberto com erro inline (não fechou: erro visível e
    // submit reabilitado); nenhum toast do wrapper.
    await waitFor(() => {
      expect(screen.getByText(i18n.t('accounts.transferError'))).toBeTruthy()
    })
    expect(
      (screen.getByRole('button', { name: i18n.t('accounts.transfer.confirm') }) as HTMLButtonElement).disabled,
    ).toBe(false)
    expect(toastMocks.error).not.toHaveBeenCalled()
  })

  it('wrapper não engole rejeição: erro vira inline no modal, sem unhandled', async () => {
    const onExecuteTransfer = vi.fn(() => Promise.reject(new Error('boom')))
    render(
      <I18nextProvider i18n={i18n}>
        <AccountsView accounts={ACCOUNTS} initialViewMode="grid" onExecuteTransfer={onExecuteTransfer} />
      </I18nextProvider>,
    )

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.metrics.transfer') }))
    })
    fillValidAmount()
    await act(async () => {
      submit()
    })
    await waitFor(() => {
      expect(onExecuteTransfer).toHaveBeenCalledTimes(1)
    })
    // Rejeição atravessa a view sem swallow e vira erro inline no modal.
    await waitFor(() => {
      expect(screen.getByText(i18n.t('accounts.transferError'))).toBeTruthy()
    })
    expect(toastMocks.error).not.toHaveBeenCalled()
  })
})
