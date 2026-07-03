# Zenith Sender — CRM de WhatsApp com SDR de IA

> CRM de WhatsApp que qualifica, responde e faz follow-up dos seus
> leads sozinho — 24 horas por dia. Inbox compartilhado, contatos,
> pipelines de vendas, disparos, automações sem código e um SDR de IA.

[![License: MIT](https://img.shields.io/badge/License-MIT-violet.svg)](./LICENSE)
[![Next.js 16](https://img.shields.io/badge/Next.js-16-black?logo=nextdotjs)](https://nextjs.org)
[![Supabase](https://img.shields.io/badge/Supabase-Postgres%20%2B%20Auth-3ecf8e?logo=supabase)](https://supabase.com)

Produto interno da **Zenith Growth**. App em produção:
[zenithsender.crmzenith.com](https://zenithsender.crmzenith.com).

## O que tem dentro

- **Inbox compartilhado** de WhatsApp — vários agentes num número,
  atribuição por conversa, status e notas.
- **SDR de IA** — um agente treinado no seu negócio qualifica,
  responde e agenda pelo WhatsApp, com follow-up automático de quem
  some, até o lead responder ou esfriar.
- **Contatos + tags + campos personalizados**, import de CSV com IA,
  deduplicação.
- **Pipelines de vendas** (Kanban) com negócios ligados às conversas.
- **Disparos** com templates aprovados pela Meta, rastreio de entrega
  e leitura, substituição de variáveis por destinatário.
- **Automações e fluxos sem código** — gatilhos em mensagens,
  contatos, palavras-chave ou agenda; ramificações, esperas, tags,
  webhooks. Construtor visual.
- **Canais dual-provider** — WhatsApp Cloud API (oficial) e Evolution
  API ao mesmo tempo, vários números por conta.
- **Contas de equipe** — convite por link, papéis (owner / admin /
  agent / viewer), transferência de propriedade.
- **Billing** — planos com trial, limites por plano, checkout via
  Asaas.
- **API REST pública** (`/api/v1`) com chaves de API escopadas e
  revogáveis. Ver [docs/public-api.md](./docs/public-api.md).

## Stack

- **App** — Next.js 16 (App Router), React 19, TypeScript, Tailwind v4.
- **Dados** — Supabase (Postgres + Auth + Storage + RLS).
- **WhatsApp** — Meta Cloud API + Evolution API.
- **IA** — OpenAI / Anthropic (SDR, geração de templates, import).
- **Fila** — Redis + BullMQ (worker do SDR).
- **Deploy** — Docker no Easypanel.

## Rodar local

```bash
npm install
cp .env.local.example .env.local   # Supabase + Meta + IA + Redis
npm run dev
```

Abra <http://localhost:3000>. Redireciona pra `/login` (ou
`/dashboard` se já autenticado).

O worker do SDR roda separado:

```bash
npm run worker
```

## Contribuindo

Padrões de commit, review e segurança em
[`CONTRIBUTING.md`](./CONTRIBUTING.md) e
[`.github/SECURITY.md`](./.github/SECURITY.md).

## Licença e créditos

[MIT](./LICENSE). Construído a partir do template open-source
[wacrm](https://github.com/ArnasDon/wacrm) de Arnas Donauskas, com
camada de canais dual-provider, SDR de IA, billing e tradução pt-BR
adicionados pela Zenith Growth.
