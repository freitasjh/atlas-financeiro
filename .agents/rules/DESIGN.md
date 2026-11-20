# DESIGN.md — Design System Grupo Atlas (Template Atlas Admin / Perfil Shadcn)

> **Contrato mandatório do projeto e padrão visual unificado do Grupo Atlas.**  
> Perfil ativo: **shadcn** (estilo `new-york`, base neutra OKLCH).  
> Template canônico: **AtlasAdminLayout** (`src/layouts/AtlasAdminLayout.tsx`).  
> Fontes da verdade: `src/tokens-shadcn.css`, `src/index.css` e `.spec/frontend/design-system-atlas-shadcn/SPEC.md`.

---

## 1. Princípios de Design

1. **Padronização Grupo Atlas**: Todas as telas e módulos devem seguir o mesmo padrão estético e estrutural do template Atlas Admin unificado.
2. **Tokens Semânticos Obrigatórios**: Componentes e telas utilizam **exclusivamente tokens semânticos**:
   - Superfícies: `--background`, `--foreground`, `--card`, `--card-foreground`, `--popover`, `--popover-foreground`.
   - Ações: `--primary`, `--primary-foreground`, `--secondary`, `--secondary-foreground`.
   - Estados: `--muted`, `--muted-foreground`, `--accent`, `--accent-foreground`, `--destructive`, `--destructive-foreground`.
   - Linhas & Controles: `--border`, `--input`, `--ring`.
   - Sidebar: `--sidebar`, `--sidebar-foreground`, `--sidebar-primary`, `--sidebar-accent`, `--sidebar-border`, `--sidebar-ring`.
   - Dataviz: `--chart-1` até `--chart-5`.
3. **Proibição de Cores Utilitárias Arbitrárias**: É terminantemente proibido o uso de classes de cores utilitárias arbitrárias (como `bg-blue-600`, `bg-slate-900`, `border-slate-200`) em botões, cartões, inputs e superfícies gerais.
4. **Semântica Financeira Restrita**: Cores de alta saturação são reservadas estritamente a dados e indicadores financeiros:
   - **Receita / Entrada**: Verde / Esmeralda (`text-emerald-600`, `bg-emerald-50`, dark: `text-emerald-400`).
   - **Despesa / Saída**: Carmim / Rose (`text-rose-600`, `bg-rose-50`, dark: `text-rose-400`).
   - **Alerta / Limite / Orçamento**: Âmbar (`text-amber-600`, `bg-amber-50`, dark: `text-amber-400`).
5. **Modo Escuro / Claro**: Suporte automático através da classe `.dark` no elemento `html`.

---

## 2. Tipografia Oficial

A tipografia do template é composta por duas fontes canônicas carregadas via Google Fonts:

| Função | Família | Declaração CSS | Uso |
|---|---|---|---|
| **Interface / Texto (Sans)** | **Inter** | `var(--font-sans)` | Textos, títulos, labels, menus, parágrafos |
| **Monospaced / Código (Mono)** | **JetBrains Mono** | `var(--font-mono)` | Códigos, identificadores técnicos, hashes |

### Regra de Ouro: `tabular-nums` Obrigatório
- Todo e qualquer valor monetário, percentual, data, contador ou indicador de KPI **DEVE** utilizar a classe `tabular-nums` para alinhamento estrito e sem tremulação.
- Valores monetários no backend e estado trafegam como inteiros em centavos (`BIGINT cents`), formatados exclusivamente pela função canônica `formatCurrency(cents)`.

---

## 3. Template Canônico de Layout: `AtlasAdminLayout`

A estrutura de layout da aplicação segue o componente canônico `AtlasAdminLayout`:

```tsx
import { AtlasAdminLayout } from "@/layouts/AtlasAdminLayout"

export default function MinhaPagina() {
  return (
    <AtlasAdminLayout title="Título da Página" activeView="dashboard">
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {/* Conteúdo responsivo sob @container/main */}
      </div>
    </AtlasAdminLayout>
  )
}
```

- **SidebarProvider**: Gerencia largura da sidebar (`--sidebar-width: calc(var(--spacing) * 72)`) e altura do header (`--header-height: calc(var(--spacing) * 12)`).
- **AppSidebar**: Navegação retrátil em estilo `inset` com suporte a `activeView` e grupos de links.
- **SiteHeader**: Cabeçalho padrão com breadcrumbs, busca rápida, notificações e alternador de tema.
- **Container Queries**: A área principal é contida sob `@container/main` com ritmo vertical consistente (`py-4 md:py-6`, `gap-4 md:gap-6`).

---

## 4. Biblioteca de Componentes

1. **Primitivas Shadcn**:
   - Localizadas em `src/components/shadcn/ui/` (`button`, `card`, `badge`, `sidebar`, `dialog`, `dropdown-menu`, `input`, `tabs`, `table`, etc.).
   - Camada ergonômica mantida em `src/components/ui/` reexportando e delegando para os tokens semânticos.
2. **Componentes de Domínio**:
   - `src/components/shadcn/dashboard/`: Gráficos, métricas, status de fluxo de caixa.
   - `src/components/shadcn/navigation/`: `app-sidebar`, `site-header`, navegação de usuário.
   - `src/components/shadcn/transactions/`: Listagens, filtros e formulários de lançamento.
3. **Imports Padronizados**:
   - Função utilitária de classes: SEMPRE `import { cn } from "@/lib/utils"` ou `import { cn } from "@/lib/cn"`. Nunca usar caminhos relativos quebrados.

---

## 5. Diretrizes Anti-Slop e Acessibilidade (WCAG 2.1 AA)

- **Touch Targets**: Mínimo de 44x44px em telas sensíveis ao toque (dispositivos móveis). Em tabelas densas, usar botões compactos (`h-8` ou `h-9`) com padding acessível.
- **Contraste**: Relação de contraste mínima de 4.5:1 para texto normal e 3:1 para controles de interface e gráficos.
- **Movimento Reduzido**: Respeitar `@media (prefers-reduced-motion: reduce)` desabilitando transições e animações longas.
- **Semantismo Limpo**: Não criar grids simétricos genéricos de 3 colunas sem propósito; utilizar hierarquia visual com ênfase nas informações patrimoniais prioritárias.
- **Foco por Teclado**: Todo elemento interativo deve ter contorno de foco visível (`ring-ring focus-visible:ring-1`).

---

## 6. Verificação e Gates do Frontend

Qualquer alteração em componentes ou páginas deve ser verificada pelo pipeline:
1. `npm run typecheck` — TypeScript estrito (`noUnusedLocals`, `strict`).
2. `npm run build` — Vite build e validação de artefato com `scripts/check-dist.mjs`.
3. Validação de CSP — `style-src 'self' https://fonts.googleapis.com` e `style-src-attr 'unsafe-inline'`.

