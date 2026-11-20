# Regras de Categorização Automática

**Onde encontrar:** Configurações → card **Regras de categorização**.

## O que é uma regra

Uma regra associa uma **palavra-chave** a uma **categoria de destino**. Quando você cria um lançamento cuja descrição contém a palavra-chave, o sistema **sugere** a categoria automaticamente. Regras apenas sugerem — nunca aplicam sozinhas.

## Para que serve

- Acelerar o cadastro de lançamentos recorrentes (ex.: "padaria" → Mercado).
- Reduzir erros de classificação.
- Ajudar na importação de extratos, onde a descrição vem do banco.

## Antes de começar

Categorias cadastradas em Configurações → Categorias.

## Criar uma regra

1. Acesse Configurações → **Regras de categorização**.
2. Clique em **Nova regra**.
3. Preencha:
   - **Palavra-chave** (obrigatório): ex.: "padaria".
   - **Categoria de destino** (obrigatório): selecione uma categoria.
   - **Prioridade** (número inteiro, padrão 0): maior prioridade vence em caso de conflito.
4. Clique em **Salvar**.

## Editar / Excluir

- Editar: ícone de lápis; altera palavra-chave, categoria de destino e prioridade.
- Excluir: ícone de lixeira + confirmação.

## Como funciona

- A regra é aplicada por correspondência de termo na descrição do lançamento.
- Em caso de conflito entre regras, vence a de maior prioridade; se empatar, a mais recente.
- A regra **sugere** a categoria no formulário; você pode aceitar ou trocar.
- Regras não categorizam retroativamente lançamentos já salvos.

## Boas práticas

- Use palavras-chave específicas ("uber", "ifood") para evitar falsos positivos.
- Ajuste prioridades quando uma palavra aparece em várias categorias.
- Revise as regras periodicamente conforme novos estabelecimentos aparecem.

## Problemas comuns

- **Regra não sugeriu categoria** → verifique se a palavra-chave está contida na descrição e se a categoria de destino ainda existe.
- **Categoria errada sugerida** → aumente a prioridade da regra correta ou refine a palavra-chave.
