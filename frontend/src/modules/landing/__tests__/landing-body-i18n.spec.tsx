// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, fireEvent, render } from "@testing-library/react"
import { MemoryRouter } from "react-router-dom"
import { I18nextProvider } from "react-i18next"

import i18n from "../../../i18n"
import { LandingPage } from "../pages/LandingPage"

function renderLanding() {
  return render(
    <MemoryRouter>
      <I18nextProvider i18n={i18n}>
        <LandingPage />
      </I18nextProvider>
    </MemoryRouter>,
  )
}

afterEach(async () => {
  cleanup()
  await i18n.changeLanguage("pt-BR")
})

/**
 * P2 Batch A (SEC-DEBT-36) — o corpo da landing não pode vazar pt-BR sob en-US.
 * Nomes próprios (bancos, Free/Standard/Pro/Full, depoentes) e unidades
 * (R$, "5 min", "100%", "CSV • XLSX • PDF") ficam literais de propósito.
 */
const PT_LITERALS: Record<string, readonly string[]> = {
  prova: [
    "Compatível com extratos",
    "Configuração Rápida",
    "para cadastrar contas e cartões",
    "Acesso sem Custo",
    "cobrança nesta fase de lançamento",
    "Privacidade Absoluta",
    "dos dados isolados por conta",
  ],
  recursos: [
    "Recursos de Ponta a Ponta",
    "Recursos",
    "Tudo o que suas finanças precisam",
    "Desenvolvido com foco em precisão",
    "Faturas de Cartão por Ciclo",
    "Acompanhe a fatura atual aberta",
    "Fatura Atual Aberta",
    "Limite Comprometido",
    "Fatura Aberta",
    "Limite Disponível",
    "Próximo Mês",
    "Tetos por Categoria",
    "Defina limites mensais",
    "Supermercado",
    "Lançamentos & Extrato",
    "Entradas e saídas vinculadas",
    "Fluxo Consolidado",
    "Receitas vs Despesas",
    "Importação OFX & CSV",
    "Suba o extrato do seu banco",
    "Detecção anti-duplicidade",
    "Exportação de Relatórios",
    "Exporte resumos mensais",
    "Formatos:",
    "Em breve",
  ],
  "como-funciona": [
    "Simples e Transparente",
    "Como funciona",
    "Do primeiro acesso ao domínio",
    "Cadastre ou Importe",
    "Lance despesas diárias",
    "Acompanhe e Economize",
    "Monitore limites de cartão",
    "Substituí 4 planilhas",
    "Designer Freelancer",
    "O controle de faturas futuras",
    "Analista de Sistemas",
    "A importação de extrato OFX",
    "Engenheira Civil",
  ],
  faq: [
    "Dúvidas Frequentes",
    "Ficou com alguma dúvida",
    "Respostas diretas",
    "Existe cobrança",
    "Meus dados bancários",
    "Como funciona a importação",
    "Posso cadastrar múltiplos",
    "Posso excluir minha conta",
  ],
}

const SECTION_HEADING_KEYS: Record<string, string> = {
  prova: "landing.proofTitle",
  recursos: "landing.recursosHeading",
  "como-funciona": "landing.stepsTitle",
  faq: "landing.faqHeading",
}

const FINAL_CTA_LITERALS = [
  "Assuma o controle definitivo",
  "Pronto para colocar suas finanças em ordem",
]

const FOOTER_LITERALS = [
  "Visão Geral",
  "Cartões & Faturas",
  "Tetos de Gastos",
  "Planos & Preços",
  "Importação OFX & CSV",
  "Controle de Limites",
  "Categorização Automática",
  "Como Funciona",
  "Segurança",
  "Isolamento por Conta",
  "Criptografia em Repouso",
  "Conformidade LGPD",
  "Autenticação em 2 Etapas",
  "Dúvidas Frequentes",
  "Termos de Uso",
  "Privacidade",
  "Suporte ao Usuário",
  "Todos os direitos reservados",
  "Ambiente de testes",
]

const PRICING_LITERALS = [
  "Planos Transparentes e Sem Surpresas",
  "Preços simples. Recursos sem limites.",
  "Escolha o plano ideal",
  "Faturamento Mensal",
  "Faturamento Anual",
  "Economize 20%",
  "O que está incluído",
  "Sem fidelidade ou cobrança oculta",
  "Ver Comparativo Completo de Recursos",
  "Sem taxas de adesão",
  "Cancele quando quiser",
  "controle dos seus dados",
  "Fale com nosso suporte",
  "O essencial para quem quer começar",
  "Para quem quer controle completo",
  "O plano mais completo",
  "Solução definitiva",
  "Até 2 contas cadastradas",
  "Lançamentos manuais ilimitados",
  "Gestão de cartões por ciclo",
  "Tudo o que está no plano Standard",
] as const

const MATRIX_LITERALS = [
  "Recurso / Capacidade",
  "Gestão de Contas & Lançamentos",
  "Cartões de Crédito & Faturas",
  "Orçamentos & Automação",
  "Importação & Relatórios",
  "Segurança & Suporte",
  "Contas Bancárias Cadastradas",
  "Categorização Inteligente",
  "Ilimitadas",
  "Até 2",
  "Comunidade",
  "E-mail em 48h",
  "Chat Prioritário",
  "VIP Dedicado",
] as const

async function renderEnUs() {
  await i18n.changeLanguage("en-US")
  renderLanding()
}

function textOf(selector: string): string {
  const element = document.querySelector(selector)
  expect(element, `elemento ${selector} ausente`).not.toBeNull()
  return element?.textContent ?? ""
}

function expectNoLiterals(text: string, literals: readonly string[], where: string) {
  for (const literal of literals) {
    expect(text, `pt-BR em ${where}: ${literal}`).not.toContain(literal)
  }
}

describe("whenLanguageChanges_thenHtmlLangFollows", () => {
  it("pt-BR no boot, en-US após troca e pt-BR ao voltar", async () => {
    expect(document.documentElement.lang).toBe("pt-BR")
    await i18n.changeLanguage("en-US")
    expect(document.documentElement.lang).toBe("en-US")
    await i18n.changeLanguage("pt-BR")
    expect(document.documentElement.lang).toBe("pt-BR")
  })
})

describe("whenLandingRenderedInEnUs_thenBodyHasNoPtBrLiteral", () => {
  it.each(Object.keys(PT_LITERALS))("seção #%s", async (sectionId) => {
    await renderEnUs()
    const text = textOf(`#${sectionId}`)
    expectNoLiterals(text, PT_LITERALS[sectionId], `#${sectionId}`)
    expect(text).toContain(i18n.t(SECTION_HEADING_KEYS[sectionId]))
  })

  it("CTA final traduz eyebrow e heading", async () => {
    await renderEnUs()
    // M1: a section é `landing-final-band`; o testid `landing-final-cta`
    // pertence à âncora e não cobre o texto da faixa.
    const text = textOf('[data-testid="landing-final-band"]')
    expectNoLiterals(text, FINAL_CTA_LITERALS, "CTA final")
    expect(text).toContain(i18n.t("landing.finalCtaEyebrow"))
    expect(text).toContain(i18n.t("landing.finalCtaHeading"))
  })

  it("footer traduz colunas, links e rodapé", async () => {
    await renderEnUs()
    const text = textOf("footer")
    expectNoLiterals(text, FOOTER_LITERALS, "footer")
    expect(text).toContain(i18n.t("landing.footerCopyright", { year: new Date().getFullYear() }))
    expect(text).toContain(i18n.t("landing.footerEnvNote"))
  })

  it("#planos traduz chrome, bullets e matriz comparativa", async () => {
    await renderEnUs()
    const section = document.getElementById("planos")
    expect(section).not.toBeNull()
    expectNoLiterals(section?.textContent ?? "", PRICING_LITERALS, "#planos")

    const toggle = document.querySelector('[data-testid="pricing-compare-toggle"]')
    expect(toggle).not.toBeNull()
    fireEvent.click(toggle as Element)

    const expanded = document.getElementById("planos")
    expectNoLiterals(expanded?.textContent ?? "", MATRIX_LITERALS, "matriz comparativa")
    for (const planName of ["Free", "Standard", "Pro", "Full"]) {
      expect(expanded?.textContent ?? "").toContain(planName)
    }
    expect(expanded?.textContent ?? "").toContain(i18n.t("pricing.compareHeader"))
  })
})
