# Orçamentos (Tetos Mensais)

**Onde encontrar:** Configurações → card **Orçamentos**.

## O que é um orçamento

Um orçamento (teto) define um **limite mensal de gasto para uma categoria**. O sistema compara o gasto real do mês com o teto e mostra o status: dentro do teto, atenção ou estourado.

## Para que serve

- Controlar o consumo por categoria mês a mês.
- Visualizar o progresso (barra de uso) e alertas ao atingir 80% e 100%.
- Detalhar quais lançamentos compuseram o gasto da categoria no mês.

## Antes de começar

É preciso ter **categorias do tipo despesa** cadastradas (Configurações → Categorias). Sem categoria, não é possível criar teto.

## Criar um teto

1. Acesse Configurações → **Orçamentos**.
2. Clique em **Novo teto**.
3. Preencha:
   - **Categoria** (obrigatório): selecione uma categoria de despesa.
   - **Mês** (obrigatório): informe qualquer dia do mês; o sistema ajusta automaticamente para o dia 01.
   - **Teto** (obrigatório): valor limite. Ex.: 1.500,00.
4. Clique em **Salvar**.

### Dicas de preenchimento

- O teto não pode ser negativo.
- Não pode existir dois tetos para a mesma categoria no mesmo mês.

## Editar um teto

1. Clique em **Editar** no card do teto.
2. Altere o mês e/ou o teto.
3. Se mudar a categoria ou o mês, o teto anterior é substituído.

## Excluir um teto

1. Clique em **Excluir** no card.
2. Confirme a exclusão.

## Como o gasto é calculado

- Soma dos lançamentos do mês daquela categoria.
- **Apenas despesas** contam; receitas não consomem teto.
- **Transferências e pagamentos de fatura são excluídos** — não são gasto.
- Lançamentos sem categoria não entram em nenhum teto.
- Lançamentos com data futura só contam quando a data chegar.

## Status (faixas)

| Status | Condição |
|--------|----------|
| Dentro do teto | gasto abaixo de 80% do teto |
| Atenção | entre 80% e 100% do teto |
| Estourado | gasto igual ou acima de 100% |
| Sem teto | teto igual a zero |

## Ver lançamentos da categoria

Clique em **Ver lançamentos** no card para abrir a lista de lançamentos reais da categoria no mês (data, descrição e valor). Útil para entender o que consumiu o teto.

## Boas práticas

- Crie tetos para as categorias de despesa mais relevantes (Mercado, Transporte, Lazer).
- Revise os tetos no início de cada mês conforme sua renda.
- Use o "Dividir despesa" (split) para alocar partes de uma compra em categorias diferentes e alimentar os tetos corretamente.

## Problemas comuns

- **"Já existe um teto para esta categoria neste mês"** → edite o teto existente em vez de criar outro.
- **Gasto não bate** → verifique se os lançamentos estão categorizados e com data no mês; transferências não contam.
- **Categoria não aparece no seletor** → crie categorias do tipo despesa em Configurações → Categorias.
