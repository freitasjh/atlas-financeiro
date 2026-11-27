# Aprovação humana — golden AUTH-01 (2026-11-25)

Aprovação humana nesta sessão (sem nome de pessoa). Registrada em 2026-11-25.

- Data: 2026-11-25
- Aprovadores (papéis, não pessoas): `product-manager` + `qa-engineer`
- Artefato de assinatura: `.doc/aprovacoes/auth-golden-2026-11-25.md`

## Escopo

Golden AUTH-01 do ciclo `auth-sessao-cliente` e seus 2 `expected` de rotas novas:

- `POST /auth/login` — aprovado por `product-manager`
- `POST /auth/refresh` — aprovado por `qa-engineer`

## Valores aprovados (idênticos para ambas as rotas)

- `status`: `200`
- `body`: `{ "version": "v1", "data": { "accessToken": "<PLACEHOLDER_TOKEN>", "refreshToken": "<PLACEHOLDER_TOKEN>", "expiresIn": 900 } }`
- `headers`: `content-type` + `x-correlation-id`

`<PLACEHOLDER_TOKEN>` e `<PLACEHOLDER_CORRELATION_ID>` são sentinéis. Nenhum JWT, PEM, segredo ou nome de pessoa é gravado neste artefato.
