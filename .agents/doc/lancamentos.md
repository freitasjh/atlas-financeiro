# Lançamentos

**Onde encontrar:** menu lateral → **Lançamentos**.

## O que é um lançamento

Um lançamento registra uma movimentação financeira: uma **entrada** (receita), uma **saída** (despesa) ou uma **transferência entre contas**. Cada lançamento tem conta, valor, data, descrição e, opcionalmente, categoria.

## Tela principal

Ao abrir Lançamentos você vê:

- **Resumo do período**: Entradas, Saídas e Resultado (saldo líquido).
- **Lista de lançamentos** com data, descrição, valor e situação (Concluída/Agendada).
- **Filtros** por busca, conta, categoria, período.
- **Paginação** (anterior/próxima) e ordenação por data ou valor.
- **Ações em massa** ao selecionar várias linhas.

## Criar um lançamento

1. Clique em **Novo lançamento** (ou pressione `N`).
2. Preencha:
   - **Conta** (obrigatório): onde a movimentação ocorre.
   - **Descrição** (obrigatório): ex.: "Supermercado".
   - **Valor** (obrigatório, maior que zero): ex.: `150,00`.
   - **Data** (obrigatório): data do lançamento.
   - **Tipo**: Entrada ou Saída (padrão Saída). Transferências são feitas em tela própria.
   - **Categoria** (opcional): aparece se houver categorias cadastradas.
3. Clique em **Salvar**.

### Situação (concluída vs agendada)

- Se a data for **hoje ou anterior**, o lançamento é **Concluída** e afeta o saldo da conta.
- Se a data for **futura**, é **Agendada** e não afeta o saldo até a data chegar.

### Dividir despesa (split)

Disponível apenas em **criação de saída**, quando a conta e o valor forem informados:

1. Ative o botão **Dividir em partes**.
2. O total da despesa é exibido.
3. Para cada parte, informe **valor** e **categoria**.
4. Use **Adicionar parte** para mais linhas; remova partes extras com o botão de remover.
5. A **soma das partes deve fechar exatamente** com o total. O sistema mostra "Restam X" ou "Passou X do total".
6. Quando a soma confere, aparece "Soma confere com o total." e é possível salvar.

> Útil para compras que envolvem várias categorias (ex.: mercado = alimentação + limpeza + higiene).

## Editar um lançamento

1. Clique em **Editar** (ícone de lápis) na linha.
2. Altere os campos desejados.
3. Clique em **Salvar**.

> Lançamentos de rateio (split) não podem ser editados por aqui — apenas excluídos.

## Excluir lançamentos

- **Um lançamento**: clique em **Excluir** e confirme.
- **Vários lançamentos**: selecione as linhas (checkbox) e use **Excluir selecionados**.
- Para lançamentos parcelados, ao excluir você escolhe: **só esta parcela** ou **esta e as parcelas futuras**.

> A exclusão remove o registro e recalcula os saldos.

## Filtros e busca

- **Buscar**: pesquisa por descrição.
- **Conta**: filtra por conta específica ou "Todas as contas".
- **Categoria**: filtra por categoria ou "Todas as categorias".
- **Período**: data inicial e final.
- **Limpar filtros**: remove todos os filtros ativos.

Quando há filtros ativos e não há resultados, aparece "Nada para estes filtros."

## Ordenação

Clique no cabeçalho da coluna para ordenar por **Data** ou **Valor**. Clique novamente para inverter (crescente/decrescente).

## Seleção e ações em massa

- Selecione linhas com o checkbox. Use Shift+clique para selecionar intervalos.
- Com linhas selecionadas, a barra flutuante oferece:
  - **Categorizar**: aplica uma categoria a todos os selecionados.
  - **Excluir**: remove os selecionados.
  - **Desfazer**: reverte a última categorização em massa.
  - **Limpar seleção**.

## Conciliação

Marque um lançamento como **Conciliado** (ícone/botão Conciliar) para indicar que foi conferido com o extrato bancário. O status aparece na coluna "Situação".

## Importar extratos

Clique em **Importar** (ou acesse `/lancamentos/importar`) para importar arquivos OFX/CSV. O sistema faz a análise e permite mapear colunas antes de confirmar.

## Alertas

- **Saldo insuficiente**: se uma saída ou transferência deixar a conta negativa, o sistema avisa e bloqueia a operação.
- **Lançamento de rateio não editável**: tentar editar uma linha de split exibe aviso.

## Atalhos de teclado

- `N` — novo lançamento (quando nenhum campo está em foco).
- `Ctrl/Cmd + K` — busca rápida (Command Palette).

## Boas práticas

- Cadastre contas e categorias antes de começar a lançar.
- Use categorias consistentes para que os orçamentos funcionem.
- Concilie lançamentos periodicamente com o extrato.
- Use o split para compras de supermercado/farmácia que misturam categorias.

## Problemas comuns

- **Campo Categoria não aparece** → cadastre ao menos uma categoria em Configurações → Categorias.
- **Não consigo salvar split** → a soma das partes deve ser exatamente igual ao total.
- **Lançamento não afeta saldo** → verifique se a data é futura (agendado).
- **"Saldo insuficiente"** → ajuste o valor ou use outra conta.
