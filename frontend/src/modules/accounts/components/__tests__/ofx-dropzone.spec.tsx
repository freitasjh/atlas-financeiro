// @vitest-environment happy-dom
// P1.2 — dropzone reutilizável (hero na página, compacto no picker).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { OfxDropzone } from '../OfxDropzone'

function renderDropzone(overrides: Partial<React.ComponentProps<typeof OfxDropzone>> = {}) {
  return render(
    <I18nextProvider i18n={i18n}>
      <OfxDropzone fileName={null} isReading={false} onFiles={() => {}} {...overrides} />
    </I18nextProvider>,
  )
}

afterEach(() => {
  cleanup()
})

describe('whenDropzoneEmpty_thenHeroShowsHints', () => {
  it('input real aceita .ofx/.qfx e mostra dica + limite', () => {
    renderDropzone()
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    expect(input.getAttribute('accept')).toBe('.ofx,.qfx')
    expect(screen.getByText(i18n.t('accounts.ofx.dropHint'))).toBeTruthy()
    expect(screen.getByText(i18n.t('accounts.ofx.limitsHint'))).toBeTruthy()
  })

  it('teclado ativa o seletor (Enter abre o picker)', () => {
    renderDropzone()
    const zone = screen.getByRole('button', { name: i18n.t('accounts.ofx.chooseFile') })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {})
    fireEvent.keyDown(zone, { key: 'Enter' })
    expect(clickSpy).toHaveBeenCalledTimes(1)
    clickSpy.mockRestore()
  })

  it('arquivo escolhido é encaminhado ao dono', () => {
    const onFiles = vi.fn()
    renderDropzone({ onFiles })
    const input = document.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['OFXHEADER:100'], 'bb.ofx', { type: 'application/x-ofx' })
    fireEvent.change(input, { target: { files: [file] } })
    expect(onFiles).toHaveBeenCalledTimes(1)
    expect((onFiles.mock.calls[0][0] as FileList)[0].name).toBe('bb.ofx')
  })
})

describe('whenFileLoaded_thenValidStateShowsName', () => {
  it('exibe nome do arquivo + resumo sem dica de arrastar', () => {
    renderDropzone({ fileName: 'bb.ofx', parsedSummary: '3 lançamentos lidos · 0 inválidos' })
    expect(screen.getByText('bb.ofx')).toBeTruthy()
    expect(screen.getByText('3 lançamentos lidos · 0 inválidos')).toBeTruthy()
    expect(screen.queryByText(i18n.t('accounts.ofx.dropHint'))).toBeNull()
  })

  it('leitura mostra processamento com live region', () => {
    renderDropzone({ isReading: true })
    expect(screen.getByText(i18n.t('accounts.ofx.processing'))).toBeTruthy()
  })
})
