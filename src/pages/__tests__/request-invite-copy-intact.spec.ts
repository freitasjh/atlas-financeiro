import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import enUS from '@/i18n/messages/en-US'
import ptBR from '@/i18n/messages/pt-BR'

const BASELINE = {
  ptBR: {
    title: 'Acesso por convite',
    body:
      'O Estica Grana é por convite. Se você precisa de acesso, peça um convite a quem administra sua conta. Se já recebeu o convite, use o link que chegou no seu e-mail.',
    goToLogin: 'Ir para o login',
    backToSite: 'Voltar ao site',
  },
  enUS: {
    title: 'Access by invitation',
    body:
      'Estica Grana is invite-only. If you need access, ask whoever manages your account for an invite. If you already received one, use the link that arrived in your email.',
    goToLogin: 'Go to sign in',
    backToSite: 'Back to site',
  },
} as const

describe('whenRequestInviteCopyAudited_thenBaselineUntouched', () => {
  it('pt-BR: 4 chaves byte-idênticas ao baseline', () => {
    expect(ptBR.auth.requestInvite.title).toBe(BASELINE.ptBR.title)
    expect(ptBR.auth.requestInvite.body).toBe(BASELINE.ptBR.body)
    expect(ptBR.auth.requestInvite.goToLogin).toBe(BASELINE.ptBR.goToLogin)
    expect(ptBR.auth.requestInvite.backToSite).toBe(BASELINE.ptBR.backToSite)
  })

  it('en-US: 4 chaves byte-idênticas ao baseline', () => {
    expect(enUS.auth.requestInvite.title).toBe(BASELINE.enUS.title)
    expect(enUS.auth.requestInvite.body).toBe(BASELINE.enUS.body)
    expect(enUS.auth.requestInvite.goToLogin).toBe(BASELINE.enUS.goToLogin)
    expect(enUS.auth.requestInvite.backToSite).toBe(BASELINE.enUS.backToSite)
  })

  it('nenhuma chave nova sob auth.requestInvite.*', () => {
    expect(Object.keys(ptBR.auth.requestInvite).sort()).toEqual(
      ['backToSite', 'body', 'goToLogin', 'title'],
    )
    expect(Object.keys(enUS.auth.requestInvite).sort()).toEqual(
      ['backToSite', 'body', 'goToLogin', 'title'],
    )
  })

  it('heading da spec de convite segue fixo nas duas fontes', () => {
    const spec = readFileSync('src/pages/__tests__/request-invite-page.spec.tsx', 'utf8')
    expect(spec, 'heading da spec alterado').toContain('/acesso por convite/i')
    expect(spec, 'texto baseline da spec alterado').toContain('O Estica Grana é por convite')
  })
})
