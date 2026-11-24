// @vitest-environment happy-dom
// P1.1/P1.2/P1.4 — página /contas/importar: PageHeader + stepper + dropzone +
// conta destino + erros role=alert; deep-link sem arquivo nunca quebra.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { ImportOfxPage } from '../ImportOfxPage'
import { useOfxTransferStore } from '../../store/ofx-transfer.store'
import { BB_FIXTURE } from '@/lib/ofx/__tests__/fixtures'

const accountRowsMock = vi.hoisted(() => ({ rows: [] as unknown[] }))
const ofxServiceMock = vi.hoisted(() => ({
  fetchExistingHashes: vi.fn(async () => new Set<string>()),
  confirmOfxImport: vi.fn(),
}))
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
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }))

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

beforeEach(() => {
  accountRowsMock.rows = [accountRow('acc-1', 'Conta Um'), accountRow('acc-2', 'Conta Dois')]
  useOfxTransferStore.getState().clearTransfer()
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('whenImportPageOpens_thenHeaderStepperAndBack', () => {
  it('PageHeader + breadcrumb Contas/Importar + voltar para /contas', async () => {
    renderPage()
    expect(await screen.findByRole('heading', { name: i18n.t('accounts.ofx.importPageTitle') })).toBeTruthy()
    const nav = screen.getByRole('navigation', { name: i18n.t('common.breadcrumb') })
    expect(nav.textContent).toContain(i18n.t('accounts.title'))
    expect(nav.textContent).toContain(i18n.t('accounts.ofx.importPageTitle'))
    const back = screen.getByRole('link', { name: i18n.t('accounts.ofx.backToAccounts') })
    expect(back.getAttribute('href')).toBe('/contas')
  })

  it('stepper com 2 etapas e aria-current na etapa 1', async () => {
    renderPage()
    const matches = await screen.findAllByText(i18n.t('accounts.ofx.stepUpload'))
    const stepItem = matches.map((el) => el.closest('li')).find((li) => li?.getAttribute('aria-current') === 'step')
    expect(stepItem).toBeTruthy()
    expect(screen.getByText(i18n.t('accounts.ofx.stepReview'))).toBeTruthy()
  })
})

describe('whenDeepLinkWithoutFile_thenEmptyStateWorks', () => {
  it('estado vazio funcional: dropzone + conta, sem quebra e sem alerta', async () => {
    renderPage('/contas/importar')
    expect(await screen.findByText(i18n.t('accounts.ofx.dropHint'))).toBeTruthy()
    expect(screen.getByLabelText(i18n.t('accounts.targetAccount'))).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('pré-seleciona a conta do ?conta=', async () => {
    renderPage('/contas/importar?conta=acc-2')
    const select = (await screen.findByLabelText(i18n.t('accounts.targetAccount'))) as HTMLSelectElement
    await waitFor(() => expect(select.value).toBe('acc-2'))
  })
})

describe('whenFilePicked_thenEtapa1ShowsValidState', () => {
  it('conta destino usa w-full e arquivo inválido gera role=alert', async () => {
    renderPage()
    const select = (await screen.findByLabelText(i18n.t('accounts.targetAccount'))) as HTMLSelectElement
    expect(select.className).toContain('w-full')
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File(['x'], 'nota.txt', { type: 'text/plain' })] } })
    await screen.findByRole('alert')
  })

  it('estado vazio mostra helper de limite', async () => {
    renderPage('/contas/importar')
    expect(await screen.findByText(i18n.t('accounts.ofx.limitsHint'))).toBeTruthy()
  })

  it('arquivo válido exibe nome + selo de formato', async () => {
    renderPage()
    await screen.findByLabelText(i18n.t('accounts.targetAccount'))
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    fireEvent.change(input, { target: { files: [new File([BB_FIXTURE], 'bb.ofx', { type: 'application/x-ofx' })] } })
    await screen.findByText('bb.ofx')
    expect(screen.getByText(i18n.t('accounts.ofx.fileValid'))).toBeTruthy()
  })

  it('handoff do picker (store) já abre com arquivo sem novo upload', async () => {
    useOfxTransferStore.getState().setTransfer({
      fileText: BB_FIXTURE,
      fileName: 'bb.ofx',
      accountId: 'acc-2',
    })
    renderPage('/contas/importar?conta=acc-2')
    await screen.findByText('bb.ofx')
    const select = screen.getByLabelText(i18n.t('accounts.targetAccount')) as HTMLSelectElement
    expect(select.value).toBe('acc-2')
  })
})
