// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { TransferModal } from '../TransferModal'
import { EditAccountModal } from '../EditAccountModal'
import { DeleteAccountDialog } from '../DeleteAccountDialog'
import { ImportOfxModal } from '../ImportOfxModal'
import { NewAccountModal } from '../NewAccountModal'
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

function content(): HTMLElement {
  return document.querySelector('[data-slot="dialog-content"]') as HTMLElement
}

function renderWithI18n(node: React.ReactNode) {
  return render(<I18nextProvider i18n={i18n}>{node}</I18nextProvider>)
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenTransferModalRenders_thenFooterIsAlwaysVisible', () => {
  it('content p-0/gap-0/flex-col, header e footer shrink-0, corpo rolável (C-A5)', () => {
    renderWithI18n(
      <TransferModal open onOpenChange={() => {}} accounts={ACCOUNTS} initialSourceAccountId="acc-1" onExecuteTransfer={async () => true} />,
    )

    const dialog = content()
    for (const cls of ['p-0', 'gap-0', 'flex', 'flex-col', 'max-h-[92vh]', 'overflow-hidden']) {
      expect(dialog.className).toContain(cls)
    }

    const header = dialog.querySelector('[data-slot="dialog-header"]') as HTMLElement
    expect(header.className).toContain('shrink-0')

    const body = screen.getByTestId('transfer-modal-body')
    for (const cls of ['flex-1', 'min-h-0', 'overflow-y-auto', 'overscroll-contain']) {
      expect(body.className).toContain(cls)
    }

    const footer = dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement
    for (const cls of ['gap-3', 'justify-end', 'sm:space-x-0', 'shrink-0']) {
      expect(footer.className).toContain(cls)
    }
  })
})

describe('whenEditAccountModalRenders_thenFooterIsAlwaysVisible', () => {
  it('mesma anatomia de modal com rodapé fixo (C-A5)', () => {
    renderWithI18n(
      <EditAccountModal open account={ACCOUNTS[0]} onOpenChange={() => {}} onSubmit={() => {}} />,
    )

    const dialog = content()
    for (const cls of ['p-0', 'gap-0', 'flex', 'flex-col', 'max-h-[92vh]', 'overflow-hidden']) {
      expect(dialog.className).toContain(cls)
    }
    expect((dialog.querySelector('[data-slot="dialog-header"]') as HTMLElement).className).toContain('shrink-0')

    const body = screen.getByTestId('edit-account-modal-body')
    for (const cls of ['flex-1', 'min-h-0', 'overflow-y-auto', 'overscroll-contain']) {
      expect(body.className).toContain(cls)
    }

    const footer = dialog.querySelector('[data-slot="dialog-footer"]') as HTMLElement
    for (const cls of ['gap-3', 'justify-end', 'sm:space-x-0', 'shrink-0']) {
      expect(footer.className).toContain(cls)
    }
  })
})

describe('whenDeleteDialogRenders_thenFooterHasGap', () => {
  it('rodapé com gap-3 e sem space-x encadeado (C-A6)', () => {
    renderWithI18n(
      <DeleteAccountDialog open accountName="Conta Um" error={null} isDeleting={false} onOpenChange={() => {}} onConfirm={() => {}} />,
    )

    const footer = content().querySelector('[data-slot="dialog-footer"]') as HTMLElement
    expect(footer.className).toContain('gap-3')
    expect(footer.className).toContain('sm:space-x-0')
  })
})

describe('whenOfxPickerRenders_thenAccessibleNameFollowsVisibleLabel', () => {
  it('nome acessível vem do <label htmlFor>, sem aria-label sobrescrevendo (C-A15)', () => {
    renderWithI18n(<ImportOfxModal open onOpenChange={() => {}} accounts={ACCOUNTS} initialAccountId="acc-1" />)

    const trigger = screen.getByRole('combobox', { name: i18n.t('accounts.ofx.accountLabel') })
    expect(trigger).toBeTruthy()
    expect(trigger.getAttribute('aria-label')).toBeNull()
    expect(screen.queryByRole('combobox', { name: 'Conta de destino' })).toBeNull()
  })
})

describe('whenAccountSelectorsRender_thenTheyUseDesignSystemSelect', () => {
  it('TransferModal não usa <select> nativo (C-S4)', () => {
    renderWithI18n(
      <TransferModal open onOpenChange={() => {}} accounts={ACCOUNTS} initialSourceAccountId="acc-1" onExecuteTransfer={async () => true} />,
    )

    expect(content().querySelector('select:not([aria-hidden="true"])')).toBeNull()
    const triggers = content().querySelectorAll('[data-slot="select-trigger"]')
    expect(triggers.length).toBe(2)
    expect(screen.getByRole('combobox', { name: i18n.t('accounts.sourceAccount') })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: i18n.t('accounts.targetAccount') })).toBeTruthy()
  })

  it('ImportOfxModal não usa <select> nativo (C-S4)', () => {
    renderWithI18n(<ImportOfxModal open onOpenChange={() => {}} accounts={ACCOUNTS} initialAccountId="acc-1" />)

    expect(content().querySelector('select:not([aria-hidden="true"])')).toBeNull()
    expect(content().querySelector('[data-slot="select-trigger"]')).not.toBeNull()
  })

  it('Select do design system abre por teclado como listbox ARIA (C-S4)', async () => {
    const user = userEvent.setup()
    renderWithI18n(
      <TransferModal open onOpenChange={() => {}} accounts={ACCOUNTS} initialSourceAccountId="acc-1" onExecuteTransfer={async () => true} />,
    )

    const trigger = screen.getByRole('combobox', { name: i18n.t('accounts.sourceAccount') })
    expect(trigger.getAttribute('data-slot')).toBe('select-trigger')
    expect(trigger.textContent).toContain('Conta Um')

    trigger.focus()
    await user.keyboard('{ArrowDown}')

    const options = screen.getAllByRole('option')
    expect(options).toHaveLength(2)
    expect(options[1]?.textContent).toContain('Conta Dois')
    expect(options[0]?.getAttribute('aria-selected')).toBe('true')

    await user.keyboard('{Escape}')
    expect(screen.queryByRole('listbox')).toBeNull()
    // O trigger volta a ser o valor exibido (nada muda sem seleção explícita).
    expect(
      screen.getByRole('combobox', { name: i18n.t('accounts.sourceAccount') }).textContent,
    ).toContain('Conta Um')
  })
})

describe('whenAmountFieldRenders_thenCurrencyPrefixIsText', () => {
  it('TransferModal usa prefixo R$ fixo e não ícone DollarSign (C-S3)', () => {
    renderWithI18n(
      <TransferModal open onOpenChange={() => {}} accounts={ACCOUNTS} initialSourceAccountId="acc-1" onExecuteTransfer={async () => true} />,
    )

    const amount = screen.getByLabelText(i18n.t('accounts.transfer.amountLabel')) as HTMLInputElement
    const field = amount.parentElement as HTMLElement
    expect(field.textContent).toContain('R$')
    expect(field.querySelector('svg')).toBeNull()
  })

  it('NewAccountModal usa prefixo R$ fixo no saldo inicial (C-S3)', () => {
    renderWithI18n(<NewAccountModal open onOpenChange={() => {}} onSubmit={() => {}} />)

    const balance = screen.getByLabelText(i18n.t('accounts.initialBalance')) as HTMLInputElement
    const field = balance.parentElement as HTMLElement
    expect(field.textContent).toContain('R$')
    expect(field.querySelector('svg')).toBeNull()
  })
})

describe('whenTypeGroupRendersInNewAccountModal_thenItIsAFieldset', () => {
  it('grupo de tipo usa fieldset + legend (C-S2)', () => {
    renderWithI18n(<NewAccountModal open onOpenChange={() => {}} onSubmit={() => {}} />)

    const fieldset = content().querySelector('fieldset')
    expect(fieldset).not.toBeNull()
    const legend = fieldset?.querySelector('legend')
    expect(legend?.textContent).toBe(i18n.t('accounts.typeLabel'))
  })
})

describe('whenNewAccountHasInvalidField_thenErrorIsLinkedByAriaDescribedby', () => {
  it('apelido vazio liga o campo à mensagem de erro (C-S1)', async () => {
    const user = userEvent.setup()
    renderWithI18n(<NewAccountModal open onOpenChange={() => {}} onSubmit={() => {}} />)

    await user.click(screen.getByRole('button', { name: i18n.t('accounts.saveBankAccount') }))

    const nickname = screen.getByLabelText(i18n.t('accounts.nickname')) as HTMLInputElement
    expect(nickname.getAttribute('aria-invalid')).toBe('true')
    const describedBy = nickname.getAttribute('aria-describedby')
    expect(describedBy).toBeTruthy()
    const message = document.getElementById(describedBy as string)
    expect(message).not.toBeNull()
    expect(message?.textContent).toBe(i18n.t('accounts.nameError'))
  })

  it('campo válido não herda descrição de erro de outro campo (C-S1)', async () => {
    const user = userEvent.setup()
    renderWithI18n(<NewAccountModal open onOpenChange={() => {}} onSubmit={() => {}} />)

    await user.click(screen.getByRole('button', { name: i18n.t('accounts.saveBankAccount') }))

    const balance = screen.getByLabelText(i18n.t('accounts.initialBalance')) as HTMLInputElement
    expect(balance.getAttribute('aria-invalid')).toBe('false')
    expect(balance.getAttribute('aria-describedby')).toBeNull()
    // A máscara de moeda normaliza qualquer texto para centavos, então o erro
    // de saldo é defensivo: o vínculo existe no campo, mas só aparece nesse caso.
    expect(document.getElementById('new-account-balance-error')).toBeNull()
  })
})

describe('whenStatementHasNoRows_thenEmptyMessagesAreDistinct', () => {
  it('chaves de vazio e de filtro sem resultado são diferentes nos 2 idiomas (C-S8)', async () => {
    expect(i18n.exists('accounts.statement.empty')).toBe(true)
    expect(i18n.exists('accounts.statement.emptyFiltered')).toBe(true)
    expect(i18n.t('accounts.statement.empty')).not.toBe(i18n.t('accounts.statement.emptyFiltered'))

    await i18n.changeLanguage('en-US')
    expect(i18n.t('accounts.statement.empty')).not.toBe(i18n.t('accounts.statement.emptyFiltered'))
  })
})

describe('whenModalsRender_thenAccessibleLabelsComeFromVisibleText', () => {
  it('campos do TransferModal mantêm rótulos visíveis associados', () => {
    renderWithI18n(
      <TransferModal open onOpenChange={() => {}} accounts={ACCOUNTS} initialSourceAccountId="acc-1" onExecuteTransfer={async () => true} />,
    )

    const dialog = content()
    expect(within(dialog).getByLabelText(i18n.t('accounts.transfer.dateLabel'))).toBeTruthy()
    expect(within(dialog).getByLabelText(i18n.t('accounts.transfer.descriptionLabel'))).toBeTruthy()
  })
})
