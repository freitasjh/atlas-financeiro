// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { SummaryHeader } from '../SummaryHeader'
import type { AccountViewItem, TreasuryMetricsCents } from '../../model/view-model'

const ACCOUNT: AccountViewItem = {
  id: 'acc-1',
  nickname: 'Conta Um',
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

const NO_PROJECTIONS: TreasuryMetricsCents = {
  totalConsolidatedBalanceCents: 100000,
  totalAvailableBalanceCents: 100000,
  totalBlockedBalanceCents: 0,
  projectedInflow15DaysCents: 0,
  projectedOutflow15DaysCents: 0,
  monthYieldCDICents: 0,
  yieldPercentageCDI: 0,
  hasProjections: false,
}

const WITH_PROJECTIONS: TreasuryMetricsCents = {
  ...NO_PROJECTIONS,
  projectedInflow15DaysCents: 50000,
  projectedOutflow15DaysCents: 20000,
  monthYieldCDICents: 1200,
  yieldPercentageCDI: 104,
  hasProjections: true,
}

function renderHeader(metrics: TreasuryMetricsCents) {
  return render(
    <I18nextProvider i18n={i18n}>
      <SummaryHeader account={ACCOUNT} metrics={metrics} onOpenTransfer={() => {}} onOpenImportOFX={() => {}} />
    </I18nextProvider>,
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage('pt-BR')
})

describe('whenThereAreNoProjections_thenSummaryReflowsWithoutEmptyColumn', () => {
  it('identidade ocupa 7 colunas e ações 5 — nenhuma coluna vazia (B-A13)', () => {
    const { container } = renderHeader(NO_PROJECTIONS)

    expect(container.querySelector('.lg\\:col-span-7')).not.toBeNull()
    expect(container.querySelector('.lg\\:col-span-5')).not.toBeNull()
    expect(container.querySelector('.lg\\:col-span-4')).toBeNull()
    expect(container.querySelector('.lg\\:col-span-3')).toBeNull()
  })

  it('mantém o saldo em destaque e o aviso honesto de projeções (B-A13)', () => {
    renderHeader(NO_PROJECTIONS)

    expect(screen.getByText(i18n.t('accounts.summary.typeChecking'))).toBeTruthy()
    expect(screen.getByText(i18n.t('accounts.metrics.projectionsUnavailable'))).toBeTruthy()
    expect(screen.getByRole('button', { name: i18n.t('accounts.summary.transferCta') })).toBeTruthy()
  })
})

describe('whenThereAreProjections_thenSummaryKeepsTheThreeColumnVerdict', () => {
  it('volta ao grid 5/4/3 (B-A13)', () => {
    const { container } = renderHeader(WITH_PROJECTIONS)

    expect(container.querySelector('.lg\\:col-span-5')).not.toBeNull()
    expect(container.querySelector('.lg\\:col-span-4')).not.toBeNull()
    expect(container.querySelector('.lg\\:col-span-3')).not.toBeNull()
    expect(container.querySelector('.lg\\:col-span-7')).toBeNull()
    expect(screen.getByText(i18n.t('accounts.summary.projection'))).toBeTruthy()
  })
})
