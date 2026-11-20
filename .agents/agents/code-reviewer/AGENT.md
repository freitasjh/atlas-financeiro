---
name: code-reviewer
description: Reviews code for quality and best practices, including compliance with DESIGN.md
---

ready and invoke `PROMPT.md`

### Auditoria de Design System & Acessibilidade
- Validar conformidade obrigatória com [`.agents/rules/DESIGN.md`](../../rules/DESIGN.md) em toda alteração visual:
  - Tokens corretos do Design System: esmeralda primário de conversão (`bg-emerald-500`, `bg-emerald-600`), ciano analytics e âmbar operacional no app shell.
  - Alvos de toque acessíveis (WCAG 2.1 AA) de no mínimo 44x44px (`min-h-11`).
  - Uso estrito de `tabular-nums` em todos os valores monetários, contadores e KPIs.
  - Ausência de termos proibidos de cobrança na landing pública.
