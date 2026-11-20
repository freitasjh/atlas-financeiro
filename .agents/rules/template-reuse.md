# Proposta de regra — Template Reuse: componentes são para serem usados, não recriados

> Status: **PROPOSTA — aguarda aplicação humana**.
> Gate: `.agents/rules/**` é path protegido (gate-contract.md I9); escrita negada por runtime.
> Aplicação: mover este arquivo para `.agents/rules/template-reuse.md` — é auto-carregado
> por `opencode.json` → `instructions: [".agents/rules/*.md"]`.
> Decisão humana: 2026-11-17.

## 1. Princípio

Componentes do catálogo em `src/components/shadcn/**` são **reutilizáveis por design**.
Quando existir um componente no catálogo para a necessidade, **use-o**. Não crie
versão paralela dentro de `src/modules/**`.

- ✅ usar / compor o componente do catálogo;
- ✅ evoluir o componente do catálogo no lugar (props/slots novos, ajustes de pixel);
- ❌ copiar o JSX para componente novo no módulo e ajustar à parte;
- ❌ manter duas implementações do mesmo componente (template + módulo).

Motivo: recriar componentes do template em módulos separados gerou duplicação,
quebras recorrentes de layout e divergência visual. Meta: sistema com o **mesmo
layout do template**, pelo menos nos componentes.

## 2. Evolução permitida

Ajustes devem ir **para o componente do catálogo**:

- acrescentar botão, prop, slot ou variante;
- corrigir 1px de alinhamento, espaçamento ou contraste;
- adaptar o contrato para dados do domínio (`amountCents`, `formatCentsBRL`, handlers
  reais) **sem trocar o layout**.

Layout aprovado do template é a base. Mudança de layout só com decisão explícita.

## 3. Evolução upstream

Melhorias no catálogo devem ser enviadas de volta ao projeto do template via **issue
no repositório do template**, com o que mudou e por quê. Assim o template evolui junto
e o sistema não acumula fork local.

## 4. Regras que esta regra revisa

Decisões anteriores que proibiam importar `src/components/shadcn/credit-card/**` no
módulo (boundary spec, SPEC §7, parecer `rf03-fidelidade-visual-cartoes-parecer`)
ficam **supersedidas por esta**, no escopo de componentes reutilizáveis do catálogo.

Permanecem válidas as salvaguardas de domínio (incidente
`harness/installer-sobrescreve-src-bank-accounts`, 2026-11-13):

- nunca substituir componente integrado a **BIGINT cents** por API crua do template
  com float/`amount`/`currentBalance` sem conversão — adapte o contrato;
- nunca copiar dados mock, ações falsas (Pix/Boleto/PDF/Linha Digitável) ou
  `formatBRL` com float;
- RLS `auth.uid() = user_id`, PCI (PAN/CVV fora de DB/log/bundle) e ADR-004 permanecem.

## 5. Aplicação

- Ao aplicar, arquivo vai para `.agents/rules/template-reuse.md` (auto-carregado).
- Conflito "criar versão no módulo" × "usar componente do catálogo" ⇒ **usar o do
  catálogo**, registrando decisão em `workflow-state.json.overrides` quando suprimir
  regra anterior.
- Agente já alterando um componente do catálogo tem precedência: não editar o mesmo
  arquivo em paralelo — coordenar antes.
