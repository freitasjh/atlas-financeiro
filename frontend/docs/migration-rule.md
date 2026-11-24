# Regra de migração por tela (fatia 2)

Rótulo: M2 — big-bang autorizado por override humano em 2026-11-23. Nesta
fatia, 0 tela migrada e 0 endpoint de domínio novo. A regra abaixo vale
para a fatia 2, depois que o root único estiver aceito.

1. Pinar status, corpo e header da resposta do legado com teste antes da troca.
2. Implementar a mesma forma no root novo, validada pelo contrato v1.
3. Rodar o teste nos dois lados (legado e root novo).
4. Trocar a tela somente após aprovação revisada.
5. Rollback = decisão humana sobre o controle de versão, não reativar um
   root paralelo — o rollback aditivo acabou com a deleção da árvore antiga.

Legado sai de produção apenas após cada tela validada. Servidor
compartilhado e inclusão de meios de cobrança ficam fora desta regra.
O acoplamento remanescente está registrado no documento de dívida do root
como dívida localizada — nunca como isolamento.
