// @vitest-environment happy-dom
// P2.1..P2.4 + 3 amarelos Batch 2 — staging full-width na página,
// stepper/foco/voltar, confirmação/sucesso/erro-parcial, descarte,
// clearTransfer, useNavigate, store reativo.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { ImportOfxPage } from '../ImportOfxPage'
import { ImportOfxModal } from '../../components/ImportOfxModal'
import { useOfxTransferStore } from '../../store/ofx-transfer.store'
import { BB_FIXTURE } from '@/lib/ofx/__tests__/fixtures'
import type { AccountViewItem } from '../../model/view-model'

const accountRowsMock = vi.hoisted(() => ({ rows: [] as unknown[] }))
const ofxServiceMock = vi.hoisted(() => ({
  fetchExistingHashes: vi.fn(),
  confirmOfxImport: vi.fn(),
}))
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('@/modules/accounts/service/accounts.service', () => ({
  listAccounts: vi.fn(async () => accountRowsMock.rows),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
  recalcAccount: vi.fn(async () => {}),
}))

vi.mock('@/modules/accounts/service/ofx-import.service', () => ofxServiceMock)

vi.mock('@/lib/supabase', () => ({
  supabase: {
    from: (table: string) => {
      if (table === 'categories' || table === 'rules') {
        const chain = { select: vi.fn(), order: vi.fn(async () => ({ data: [], error: null })) }
        chain.select.mockReturnValue(chain)
        return chain
      }
      throw new Error(`unexpected-table:${table}`)
    },
  },
}))

vi.mock('sonner', () => ({ toast: toastMock }))

function accountRow(id: string, name: string) {
  return {
    id,
    user_id: 'u1',
    name,
    type: 'checking',
    initial_balance_cents: 100000,
    current_balance_cents: 100000,
    color: null,
    institution: 'itau',
    agency: '0001',
    account_number: '12345',
    account_digit: '0',
    is_default: false,
    connection_status: 'manual',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  } as never
}

function renderPage(entry = '/contas/importar?conta=acc-1') {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[entry]}>
        <ImportOfxPage />
      </MemoryRouter>
    </I18nextProvider>,
  )
}

async function pickValidFile() {
  await screen.findByLabelText(i18n.t('accounts.targetAccount'))
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([BB_FIXTURE], 'bb.ofx', { type: 'application/x-ofx' })] } })
}

beforeEach(() => {
  accountRowsMock.rows = [accountRow('acc-1', 'Conta Um'), accountRow('acc-2', 'Conta Dois')]
  useOfxTransferStore.getState().clearTransfer()
  ofxServiceMock.fetchExistingHashes.mockReset()
  ofxServiceMock.confirmOfxImport.mockReset()
  toastMock.success.mockClear()
  toastMock.error.mockClear()
  ofxServiceMock.fetchExistingHashes.mockResolvedValue(new Set<string>())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('whenValidFilePicked_thenStagingFullWidthWithSingleCta', () => {
  it('mostra contagens + toolbar <search> + Confirmar(N) sem duplicar CTA', async () => {
    renderPage()
    await pickValidFile()
    await screen.findByText(i18n.t('accounts.staging.counts', { new: 3, dup: 0, invalid: 0 }))
    const toolbar = document.querySelector('search[aria-label]') as HTMLElement
    expect(toolbar).toBeTruthy()
    expect(toolbar.tagName.toLowerCase()).toBe('search')
    expect(toolbar.getAttribute('aria-label')).toBe(i18n.t('accounts.staging.searchLabel'))
    const confirm = within(toolbar).getByRole('button', {
      name: i18n.t('accounts.staging.confirm', { count: 3 }),
    })
    expect((confirm as HTMLButtonElement).disabled).toBe(false)
    expect(screen.getAllByRole('button', { name: i18n.t('accounts.staging.confirm', { count: 3 }) })).toHaveLength(1)
  })
})

describe('whenStageChanges_thenStepperAndFocusAreManaged', () => {
  it('etapa 2 com aria-current + foco no título da revisão', async () => {
    renderPage()
    await pickValidFile()
    await screen.findByText(i18n.t('accounts.staging.counts', { new: 3, dup: 0, invalid: 0 }))
    const reviewItem = screen
      .getAllByText(i18n.t('accounts.ofx.stepReview'))
      .map((el) => el.closest('li'))
      .find((li) => li?.getAttribute('aria-current') === 'step')
    expect(reviewItem).toBeTruthy()
    await waitFor(() => expect(document.activeElement?.getAttribute('data-testid')).toBe('import-review-heading'))
  })

  it('voltar para o envio preserva arquivo e conta sem descarte', async () => {
    renderPage('/contas/importar?conta=acc-2')
    await pickValidFile()
    await screen.findByText(i18n.t('accounts.staging.counts', { new: 3, dup: 0, invalid: 0 }))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.backToUpload') }))
    expect(await screen.findByText('bb.ofx')).toBeTruthy()
    const select = screen.getByLabelText(i18n.t('accounts.targetAccount')) as HTMLSelectElement
    expect(select.value).toBe('acc-2')
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('whenConfirmSucceeds_thenLoadingSuccessAndToast', () => {
  it('botão carrega (disabled+spinner) e tela de sucesso com CTAs + toast', async () => {
    ofxServiceMock.confirmOfxImport.mockImplementation(
      async () => ({ inserted: 3, duplicates: 0, failed: 0, aborted: 0, errors: [] }),
    )
    renderPage()
    await pickValidFile()
    const confirm = await screen.findByRole('button', {
      name: i18n.t('accounts.staging.confirm', { count: 3 }),
    })
    fireEvent.click(confirm)
    await waitFor(() => expect(ofxServiceMock.confirmOfxImport).toHaveBeenCalledTimes(1))
    expect(await screen.findByText(i18n.t('accounts.ofx.successTitle'))).toBeTruthy()
    expect(screen.getByText(i18n.t('accounts.ofx.successSummary', { count: 3, account: 'Conta Um' }))).toBeTruthy()
    expect(screen.getByRole('button', { name: i18n.t('accounts.ofx.viewStatement') })).toBeTruthy()
    expect(screen.getByRole('button', { name: i18n.t('accounts.ofx.importAnother') })).toBeTruthy()
    expect(toastMock.success).toHaveBeenCalled()
  })
})

describe('whenConfirmPartiallyFails_thenAlertWithRetry', () => {
  it('erro parcial com role=alert + retry re-tenta', async () => {
    ofxServiceMock.confirmOfxImport
      .mockResolvedValueOnce({ inserted: 2, duplicates: 0, failed: 1, aborted: 0, errors: ['chunk-1'] })
      .mockResolvedValueOnce({ inserted: 1, duplicates: 0, failed: 0, aborted: 0, errors: [] })
    renderPage()
    await pickValidFile()
    fireEvent.click(
      await screen.findByRole('button', { name: i18n.t('accounts.staging.confirm', { count: 3 }) }),
    )
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('2')
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.retry') }))
    await waitFor(() => expect(ofxServiceMock.confirmOfxImport).toHaveBeenCalledTimes(2))
  })
})

describe('whenLeavingWithoutConfirm_thenDiscardDialog', () => {
  it('trocar arquivo pede confirmação de descarte; confirmar limpa staging', async () => {
    renderPage()
    await pickValidFile()
    await screen.findByText(i18n.t('accounts.staging.counts', { new: 3, dup: 0, invalid: 0 }))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.swapFile') }))
    expect(await screen.findByText(i18n.t('accounts.ofx.discardTitle'))).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.discardYes') }))
    await waitFor(() =>
      expect(screen.queryByText(i18n.t('accounts.staging.counts', { new: 3, dup: 0, invalid: 0 }))).toBeNull(),
    )
    expect(useOfxTransferStore.getState().fileText).toBeNull()
  })
})

describe('whenTransferStoreUpdates_thenPageSubscribes', () => {
  it('handoff tardio do picker aparece sem novo upload (store reativo)', async () => {
    renderPage('/contas/importar')
    await screen.findByLabelText(i18n.t('accounts.targetAccount'))
    useOfxTransferStore.getState().setTransfer({ fileText: BB_FIXTURE, fileName: 'bb.ofx', accountId: 'acc-2' })
    await screen.findByText(i18n.t('accounts.staging.counts', { new: 3, dup: 0, invalid: 0 }))
  })
})

function pickerAccount(id: string, name: string): AccountViewItem {
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

function LocationProbe() {
  const location = useLocation()
  return <p data-testid="location-probe">{`${location.pathname}${location.search}`}</p>
}

describe('whenPickerContinuesWithRouter_thenUsesNavigateNotHash', () => {
  it('navega via useNavigate com state (sem window.location.hash)', async () => {
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/contas']}>
          <Routes>
            <Route
              path="/contas"
              element={
                <>
                  <ImportOfxModal
                    open
                    onOpenChange={() => {}}
                    accounts={[pickerAccount('acc-1', 'Conta Um'), pickerAccount('acc-2', 'Conta Dois')]}
                    initialAccountId="acc-2"
                  />
                  <LocationProbe />
                </>
              }
            />
            <Route path="/contas/importar" element={<LocationProbe />} />
          </Routes>
        </MemoryRouter>
      </I18nextProvider>,
    )
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([BB_FIXTURE], 'bb.ofx', { type: 'application/x-ofx' })] } })
    await screen.findByText('bb.ofx')
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.continueToReview') }))
    await waitFor(() => expect(screen.getByTestId('location-probe').textContent).toContain('/contas/importar'))
    expect(window.location.hash).toBe('')
    expect(useOfxTransferStore.getState().fileName).toBe('bb.ofx')
  })
})

describe('whenPickerSwaps_thenClearsTransfer', () => {
  it('trocar arquivo limpa o handoff transitório', async () => {
    useOfxTransferStore.getState().setTransfer({ fileText: BB_FIXTURE, fileName: 'bb.ofx', accountId: 'acc-1' })
    render(
      <I18nextProvider i18n={i18n}>
        <MemoryRouter initialEntries={['/contas']}>
          <ImportOfxModal open onOpenChange={() => {}} accounts={[pickerAccount('acc-1', 'Conta Um')]} initialAccountId="acc-1" />
        </MemoryRouter>
      </I18nextProvider>,
    )
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([BB_FIXTURE], 'bb.ofx', { type: 'application/x-ofx' })] } })
    await screen.findByText('bb.ofx')
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.swapFile') }))
    expect(useOfxTransferStore.getState().fileText).toBeNull()
  })
})
