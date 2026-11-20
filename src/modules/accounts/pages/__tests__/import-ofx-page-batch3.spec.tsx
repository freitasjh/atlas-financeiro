// @vitest-environment happy-dom
// P3.1 — Quality Gate: etapas/estados da página, foco gerenciado, descarte
// com confirmação, deep-link vazio/inválido/zero-contas, idempotência
// re-import, erro parcial + retry e erro total + retry.
// Padrões reusados de import-ofx-page.spec.tsx / batch2 (mocks + helpers).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { ImportOfxPage } from '../ImportOfxPage'
import { useAccountsStore } from '../../store/accounts.store'
import { useOfxTransferStore } from '../../store/ofx-transfer.store'
import { BB_FIXTURE } from '@/lib/ofx/__tests__/fixtures'

const accountRowsMock = vi.hoisted(() => ({ rows: [] as unknown[] }))
const listAccountsMock = vi.hoisted(() => vi.fn())
const ofxServiceMock = vi.hoisted(() => ({
  fetchExistingHashes: vi.fn(),
  confirmOfxImport: vi.fn(),
}))
const toastMock = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }))

vi.mock('@/modules/accounts/service/accounts.service', () => ({
  listAccounts: listAccountsMock,
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

function renderWithRoutes(entry = '/contas/importar?conta=acc-1') {
  return render(
    <I18nextProvider i18n={i18n}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/contas/importar" element={<ImportOfxPage />} />
          <Route path="/contas" element={<p data-testid="contas-index">contas</p>} />
        </Routes>
      </MemoryRouter>
    </I18nextProvider>,
  )
}

async function pickValidFile(name = 'bb.ofx') {
  await screen.findByLabelText(i18n.t('accounts.targetAccount'))
  const input = document.querySelector('input[type="file"]') as HTMLInputElement
  fireEvent.change(input, { target: { files: [new File([BB_FIXTURE], name, { type: 'application/x-ofx' })] } })
}

beforeEach(() => {
  accountRowsMock.rows = [accountRow('acc-1', 'Conta Um'), accountRow('acc-2', 'Conta Dois')]
  listAccountsMock.mockReset()
  listAccountsMock.mockImplementation(async () => accountRowsMock.rows)
  useAccountsStore.setState({ accounts: [], status: 'idle', error: null })
  useOfxTransferStore.getState().clearTransfer()
  ofxServiceMock.fetchExistingHashes.mockReset()
  ofxServiceMock.confirmOfxImport.mockReset()
  toastMock.success.mockClear()
  ofxServiceMock.fetchExistingHashes.mockResolvedValue(new Set<string>())
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('whenAccountsLoading_thenSkeletonsWithAriaBusy', () => {
  it('mostra skeleton com aria-busy enquanto carrega', async () => {
    listAccountsMock.mockImplementation(() => new Promise(() => {}))
    const { container } = renderPage()
    const busy = container.querySelector('[aria-busy="true"]')
    expect(busy).toBeTruthy()
    expect(busy?.getAttribute('aria-live')).toBe('polite')
  })
})

describe('whenAccountsFail_thenErrorWithRetry', () => {
  it('mostra alerta + retry recarrega', async () => {
    listAccountsMock.mockRejectedValueOnce(new Error('boom'))
    renderPage()
    expect(await screen.findByText(i18n.t('accounts.loadError'))).toBeTruthy()
    const retry = screen.getByRole('button', { name: i18n.t('common.retry') })
    expect(retry.className).toContain('min-h-11')
    listAccountsMock.mockImplementationOnce(async () => accountRowsMock.rows)
    fireEvent.click(retry)
    await screen.findByLabelText(i18n.t('accounts.targetAccount'))
  })
})

describe('whenUploadPhase_thenFocusManaged', () => {
  it('voltar ao envio foca o seletor de conta (não o h2 sr-only)', async () => {
    renderPage('/contas/importar?conta=acc-2')
    await pickValidFile()
    await screen.findByText(i18n.t('accounts.staging.counts', { new: 3, dup: 0, invalid: 0 }))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.backToUpload') }))
    const select = await screen.findByLabelText(i18n.t('accounts.targetAccount'))
    await waitFor(() => expect(document.activeElement).toBe(select))
    expect(document.activeElement?.getAttribute('data-testid')).not.toBe('import-upload-heading')
  })
})

describe('whenInvalidThenValidFile_thenClearsAlertAndShowsReview', () => {
  it('erro de guarda some ao escolher arquivo válido (sem staging obsoleto)', async () => {
    renderPage()
    await screen.findByLabelText(i18n.t('accounts.targetAccount'))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'nota.txt', { type: 'text/plain' })] } })
    await screen.findByRole('alert')
    fireEvent.change(input, { target: { files: [new File([BB_FIXTURE], 'bb.ofx', { type: 'application/x-ofx' })] } })
    await screen.findByText(i18n.t('accounts.staging.counts', { new: 3, dup: 0, invalid: 0 }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('whenBackToUpload_thenClearsConfirmError', () => {
  it('volta limpa o alerta parcial e foca o seletor', async () => {
    ofxServiceMock.confirmOfxImport.mockResolvedValueOnce({
      inserted: 2,
      duplicates: 0,
      failed: 1,
      aborted: 0,
      errors: ['chunk-1'],
    })
    renderPage()
    await pickValidFile()
    fireEvent.click(
      await screen.findByRole('button', { name: i18n.t('accounts.staging.confirm', { count: 3 }) }),
    )
    await screen.findByRole('alert')
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.backToUpload') }))
    const select = await screen.findByLabelText(i18n.t('accounts.targetAccount'))
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(select))
  })
})

describe('whenDiscardCancel_thenKeepsReview', () => {
  it('cancelar o descarte mantém staging e arquivo', async () => {
    renderPage()
    await pickValidFile()
    await screen.findByText(i18n.t('accounts.staging.counts', { new: 3, dup: 0, invalid: 0 }))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.swapFile') }))
    await screen.findByText(i18n.t('accounts.ofx.discardTitle'))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.cancel') }))
    await waitFor(() =>
      expect(screen.getByText(i18n.t('accounts.staging.counts', { new: 3, dup: 0, invalid: 0 })).textContent).toBeTruthy(),
    )
    expect(screen.getByText('bb.ofx')).toBeTruthy()
  })
})

describe('whenDiscardDialog_thenA11yContained', () => {
  it('DialogContent contido + footer com gap-3 sem space-x', async () => {
    renderPage()
    await pickValidFile()
    await screen.findByText(i18n.t('accounts.staging.counts', { new: 3, dup: 0, invalid: 0 }))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.swapFile') }))
    await screen.findByText(i18n.t('accounts.ofx.discardTitle'))
    const content = document.querySelector('[data-slot="dialog-content"]') as HTMLElement
    expect(content.className).toContain('max-h-[92vh]')
    expect(content.className).toContain('overflow-y-auto')
    expect(content.className).toContain('overscroll-contain')
    const footer = document.querySelector('[data-slot="dialog-footer"]') as HTMLElement
    expect(footer.className).toContain('gap-3')
    expect(footer.className).toContain('sm:space-x-0')
  })
})

describe('whenLeaveToAccountsDirty_thenDiscardDialogNavigates', () => {
  it('sair sem confirmar pede descarte; confirmar navega e limpa handoff', async () => {
    renderWithRoutes()
    await pickValidFile()
    await screen.findByText(i18n.t('accounts.staging.counts', { new: 3, dup: 0, invalid: 0 }))
    fireEvent.click(screen.getByRole('link', { name: i18n.t('accounts.ofx.backToAccounts') }))
    await screen.findByText(i18n.t('accounts.ofx.discardTitle'))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.discardYes') }))
    expect(await screen.findByTestId('contas-index')).toBeTruthy()
    expect(useOfxTransferStore.getState().fileText).toBeNull()
  })
})

describe('whenDeepLinkInvalidAccount_thenFallsBackToFirst', () => {
  it('?conta= desconhecida seleciona a primeira conta', async () => {
    renderPage('/contas/importar?conta=desconhecida')
    const select = (await screen.findByLabelText(i18n.t('accounts.targetAccount'))) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('acc-1'))
  })
})

describe('whenZeroAccounts_thenEmptyHintAndDisabledSelect', () => {
  it('sem contas: dica vazia + seletor desabilitado, sem quebra', async () => {
    accountRowsMock.rows = []
    renderPage('/contas/importar')
    expect(await screen.findByText(i18n.t('accounts.emptyHint'))).toBeTruthy()
    const select = screen.getByLabelText(i18n.t('accounts.targetAccount')) as HTMLSelectElement
    expect(select.disabled).toBe(true)
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('whenReimportSameFile_thenIdempotentDuplicates', () => {
  it('arquivo todo-duplicado desabilita Confirmar(0) e re-import funciona após sucesso', async () => {
    ofxServiceMock.fetchExistingHashes.mockImplementation(async (_accountId: string, hashes: string[]) => new Set(hashes))
    ofxServiceMock.confirmOfxImport.mockResolvedValue({
      inserted: 3,
      duplicates: 0,
      failed: 0,
      aborted: 0,
      errors: [],
    })
    renderPage()
    await pickValidFile()
    await screen.findByText(i18n.t('accounts.staging.counts', { new: 0, dup: 3, invalid: 0 }))
    const confirm = screen.getByRole('button', { name: i18n.t('accounts.staging.confirm', { count: 0 }) })
    expect((confirm as HTMLButtonElement).disabled).toBe(true)

    ofxServiceMock.fetchExistingHashes.mockResolvedValue(new Set<string>())
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.backToUpload') }))
    await screen.findByLabelText(i18n.t('accounts.targetAccount'))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([BB_FIXTURE], 'bb.ofx', { type: 'application/x-ofx' })] } })
    await screen.findByText(i18n.t('accounts.staging.counts', { new: 3, dup: 0, invalid: 0 }))
  })
})

describe('whenConfirmThrows_thenFailureAlertWithRetry', () => {
  it('falha total mostra importFailed + retry conclui com foco no sucesso', async () => {
    ofxServiceMock.confirmOfxImport
      .mockRejectedValueOnce(new Error('db-down'))
      .mockResolvedValueOnce({ inserted: 3, duplicates: 0, failed: 0, aborted: 0, errors: [] })
    renderPage()
    await pickValidFile()
    fireEvent.click(
      await screen.findByRole('button', { name: i18n.t('accounts.staging.confirm', { count: 3 }) }),
    )
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain(i18n.t('accounts.ofx.importFailed'))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.retry') }))
    expect(await screen.findByText(i18n.t('accounts.ofx.successTitle'))).toBeTruthy()
    await waitFor(() => expect(document.activeElement?.getAttribute('data-testid')).toBe('import-success-heading'))
    expect(screen.getByText(i18n.t('accounts.ofx.successSummary', { count: 3, account: 'Conta Um' }))).toBeTruthy()
  })
})

describe('whenSuccess_thenViewStatementNavigatesAndImportAnotherResets', () => {
  it('Ver extrato navega para /contas?conta=', async () => {
    ofxServiceMock.confirmOfxImport.mockResolvedValue({
      inserted: 3,
      duplicates: 0,
      failed: 0,
      aborted: 0,
      errors: [],
    })
    renderWithRoutes()
    await pickValidFile()
    fireEvent.click(
      await screen.findByRole('button', { name: i18n.t('accounts.staging.confirm', { count: 3 }) }),
    )
    await screen.findByText(i18n.t('accounts.ofx.successTitle'))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.viewStatement') }))
    await waitFor(() => expect(screen.getByTestId('contas-index')).toBeTruthy())
  })

  it('Importar outro volta ao envio com foco no seletor e sem alerta', async () => {
    ofxServiceMock.confirmOfxImport.mockResolvedValue({
      inserted: 3,
      duplicates: 0,
      failed: 0,
      aborted: 0,
      errors: [],
    })
    renderPage()
    await pickValidFile()
    fireEvent.click(
      await screen.findByRole('button', { name: i18n.t('accounts.staging.confirm', { count: 3 }) }),
    )
    await screen.findByText(i18n.t('accounts.ofx.successTitle'))
    fireEvent.click(screen.getByRole('button', { name: i18n.t('accounts.ofx.importAnother') }))
    const select = await screen.findByLabelText(i18n.t('accounts.targetAccount'))
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(select))
  })
})
