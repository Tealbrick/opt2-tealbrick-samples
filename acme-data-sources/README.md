# Acme data sources (mock)

Synthetic company data for the Teal Brick "second brain" demo: the fictional company **Acme LLC** with a fake Stripe, Slack,
Google Drive, HubSpot and a PostgreSQL orders database. Everything is invented and read only. There are no keys, no auth and no
real people (names are fictional, addresses end in `.example`). Not a product and not a miniapp: it is a plain Node service that
the DEV demo workspace connects to as a "custom MCP server".

Deterministic: fixed seed (`MOCK_SEED`, default `20261024`) and a fixed clock (2026-10-24T09:00Z), so every restart serves the
same bytes.

## Faces

| Face | Where | Content |
|---|---|---|
| MCP server (Streamable HTTP, JSON answers) | `POST /mcp` | 15 read-only tools, the text resources below, and 3 record-only Jarvis action tools (`gmail_send_email`, `facebook_reply_to_comment`, `metaads_update_campaign_budget`; nothing is sent, `GET /jarvis/actions` lists the calls) |
| REST shaped like the real APIs | `/stripe/v1/*`, `/slack/api/*`, `/drive/v3/files*`, `/hubspot/crm/v3/objects/*` | same data |
| Health | `GET /healthz` | version, seed, counts, resource counts |

Tools (all `readOnlyHint: true`): `stripe_list_customers`, `stripe_list_subscriptions`, `stripe_list_invoices`,
`stripe_list_charges`, `stripe_revenue_summary`, `slack_list_channels`, `slack_channel_history`, `slack_search_messages`,
`drive_search_files`, `drive_get_file_text`, `hubspot_list_contacts`, `hubspot_list_deals`, `postgres_list_tables`,
`postgres_describe_table`, `postgres_select` (ONE SELECT in a READ ONLY transaction, at most 200 rows, 5 s timeout).

## MCP resources (v0.3.0)

Standard `resources/list` (paged, `cursor` / `nextCursor`, 10 per page; `RESOURCES_PAGE_SIZE` changes it) and `resources/read`.
Text resources only. `resources/templates/list` answers an empty list. The server declares
`capabilities.resources = {subscribe: false, listChanged: false}`.

Every resource has `annotations.lastModified` (ISO, from the fixed clock) and `_meta: {collection, kind}`.

| Source | URI | mimeType | `_meta.kind` | `_meta.collection` |
|---|---|---|---|---|
| Google Drive doc | `acme://drive/<folder>/<fileId>` (folder path percent-encoded per segment, for example `acme://drive/Acme%20LLC/Finance/1rF9…`) | `text/markdown` | `document` | the Drive folder path, for example `Acme LLC/Finance` |
| Slack channel, one day | `acme://slack/<channel>/<YYYY-MM-DD>` (UTC day) | `text/plain`, lines `HH:MM name: text` (UTC) | `chat_transcript` | `#support`, `#sales`, `#finance`, `#general` |
| Stripe monthly revenue summary | `acme://stripe/revenue/<YYYY-MM>` | `text/markdown` | `report` | `Stripe` |
| Stripe past-due invoices | `acme://stripe/past-due-invoices` | `text/markdown` | `report` | `Stripe` |
| Stripe top customers | `acme://stripe/top-customers` | `text/markdown` | `report` | `Stripe` |
| HubSpot pipeline (open deals by stage) | `acme://hubspot/pipeline` | `text/markdown` | `report` | `HubSpot` |

An unknown URI gives JSON-RPC error `-32002` (resource not found); a bad cursor gives `-32602`. A cursor is opaque and only
valid for this server's list.

## Run

```sh
cd acme-data-sources
npm ci
npm start                       # :8080, or PORT=…; DATABASE_URL (optional) enables the orders database tools
npm run typecheck && npm run lint && npm test
node client/check.ts http://localhost:8080/mcp     # black-box check over /mcp: lists + reads every resource, calls tools
```

Without `DATABASE_URL` the `postgres_*` tools answer `database_not_configured` (row counts null) and the last check of
`client/check.ts` fails. With it, the service creates and seeds `products` (12), `orders` (420) and `order_lines` (1,012) once.

## Deploy

`Dockerfile` (Node 24, no build step). The DEV demo runs it on Railway as the service `demo-mock-sources` in the DEV project;
`DATABASE_URL` is a reference variable to the project's Postgres service. Never point it at a production environment.

This folder is not listed in `tealbrick-ci.json` `paths` (it is not a miniapp): CI runs the repo secret scan on it and nothing else.
Run the three npm checks above before a push.
