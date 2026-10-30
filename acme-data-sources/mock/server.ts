// Mock data sources for the Acme LLC second-brain workspace (Tealbrick DEV). Two faces over the same synthetic data:
//   1. REST shaped like the real APIs: /stripe/v1/*, /slack/api/*, /drive/v3/files*, /hubspot/crm/v3/objects/*
//   2. One remote MCP server (Streamable HTTP, JSON responses) at /mcp, for Connect's "custom MCP server": 15 read-only tools
//      plus text resources (resources/list with cursors, resources/read; see resources.ts), and 3 Jarvis action tools (C373
//      Jarvis: send an email, reply to a comment, change an ad budget) that only RECORD the call in memory and send nothing,
//      so a hold can be shown end to end (`GET /jarvis/actions` lists what was recorded).
// No auth, no keys, nothing leaves the service: everything is fictional. Node 24+ (type stripping): `node mock/server.ts`.

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { channels, charges, contacts, customers, deals, files, invoices, messages, NOW, SEED, stripeList, subscriptions } from "./data.ts";
import { describe, listTables, seed, select } from "./orders-db.ts";
import { listResources, PAGE_SIZE, ResourceError, readResource, resourceCount, resourceCounts } from "./resources.ts";

const PORT = Number(process.env.PORT ?? 8080);
const VERSION = "0.4.4";

// ───────── derived views ─────────
function revenueSummary() {
  const active = subscriptions.filter((s) => s.status === "active" || s.status === "past_due");
  let mrr = 0;
  for (const s of active) {
    const it = (s as { items: { data: { quantity: number; price: { unit_amount: number; recurring: { interval: string } } }[] } }).items.data[0]!;
    mrr += it.price.recurring.interval === "year" ? (it.price.unit_amount * it.quantity) / 12 : it.price.unit_amount * it.quantity;
  }
  const byStatus: Record<string, number> = {};
  for (const s of subscriptions) byStatus[s.status as string] = (byStatus[s.status as string] ?? 0) + 1;
  const failed = charges.filter((c) => c.status === "failed");
  const openInv = invoices.filter((i) => i.status === "open");
  return {
    as_of: new Date(NOW * 1000).toISOString(), currency: "eur", mrr_cents: Math.round(mrr), arr_cents: Math.round(mrr * 12),
    customers: customers.length, subscriptions_by_status: byStatus,
    failed_charges: failed.map((c) => ({ id: c.id, customer: customers.find((x) => x.id === c.customer)?.name, amount: c.amount, failure_code: c.failure_code })),
    open_invoices: openInv.map((i) => ({ id: i.id, number: i.number, customer_name: i.customer_name, amount_remaining: i.amount_remaining, attempt_count: i.attempt_count })),
    note: "Acme LLC (fictional company, synthetic data).",
  };
}
const q = (s: unknown) => String(s ?? "").toLowerCase();
const slackSearch = (query: string) => Object.values(messages).flat().filter((m) => q(m.text).includes(q(query)))
  .map((m) => ({ ...m, channel_name: channels.find((c) => c.id === m.channel)?.name }));
const driveMeta = ({ body: _b, ...meta }: (typeof files)[number]) => meta;

// ───────── MCP tools ─────────
type Args = Record<string, unknown>;
interface Tool { name: string; description: string; inputSchema: Record<string, unknown>; action?: true; run(a: Args): unknown | Promise<unknown> }
// C373 Jarvis: fictional comments on a page post (names and text are made up).
const COMMENTS = [
  { id: "c_1001", post: "p_501", author: "Giulia R. (fictional)", created: "2026-10-27T06:12:00Z", text: "Buongiorno, il corso di novembre ha ancora posti liberi?" },
  { id: "c_1002", post: "p_501", author: "Marco T. (fictional)", created: "2026-10-27T06:40:00Z", text: "Ho pagato ieri con bonifico ma non ho ricevuto la conferma. Potete controllare?" },
  { id: "c_1003", post: "p_502", author: "Utente anonimo (fictional)", created: "2026-10-27T07:05:00Z", text: "Siete dei truffatori, vergogna!!! [offensive test comment]" },
  { id: "c_1004", post: "p_502", author: "Sara L. (fictional)", created: "2026-10-27T07:31:00Z", text: "Grazie per la diretta di ieri, molto utile!" },
];
// C373 Jarvis: action tools record what they were asked; nothing is sent. Bounded, newest last, lost on restart.
const actions: { at: string; tool: string; args: Args }[] = [];
const record = (tool: string) => async (a: Args) => {
  actions.push({ at: new Date().toISOString(), tool, args: a });
  if (actions.length > 200) actions.shift();
  // QA of a client retry: record first, then answer late, so a client timeout retries a call that already happened
  const delay = Math.min(Math.max(Number(a.delay_ms) || 0, 0), 8000);
  if (delay > 0) await new Promise((r) => setTimeout(r, delay));
  return { ok: true, mock: true, recorded: actions.length, note: "Recorded only (mock). Nothing was sent." };
};
const S = (props: Record<string, unknown> = {}, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });
const lim = { type: "integer", minimum: 1, maximum: 100, description: "Max rows (default 20)" };
const take = <T>(rows: T[], a: Args) => rows.slice(0, Math.min(100, Number(a.limit ?? 20)));
const TOOLS: Tool[] = [
  { name: "stripe_list_customers", description: "Stripe (Acme LLC): list customers. Optional email or name filter.", inputSchema: S({ query: str("Part of name or email"), limit: lim }),
    run: (a) => take(customers.filter((c) => !a.query || q(c.name + c.email).includes(q(a.query))), a) },
  { name: "stripe_list_subscriptions", description: "Stripe (Acme LLC): list subscriptions, optionally by status (active, trialing, past_due, canceled) or customer id.", inputSchema: S({ status: str("Subscription status"), customer: str("cus_… id"), limit: lim }),
    run: (a) => take(subscriptions.filter((s) => (!a.status || s.status === a.status) && (!a.customer || s.customer === a.customer)), a) },
  { name: "stripe_list_invoices", description: "Stripe (Acme LLC): list invoices, optionally by status (paid, open, draft) or customer id.", inputSchema: S({ status: str("Invoice status"), customer: str("cus_… id"), limit: lim }),
    run: (a) => take(invoices.filter((i) => (!a.status || i.status === a.status) && (!a.customer || i.customer === a.customer)).reverse(), a) },
  { name: "stripe_list_charges", description: "Stripe (Acme LLC): list charges, optionally by status (succeeded, failed) or customer id.", inputSchema: S({ status: str("Charge status"), customer: str("cus_… id"), limit: lim }),
    run: (a) => take(charges.filter((c) => (!a.status || c.status === a.status) && (!a.customer || c.customer === a.customer)).reverse(), a) },
  { name: "stripe_revenue_summary", description: "Stripe (Acme LLC): MRR, ARR, subscriptions by status, failed charges and open invoices.", inputSchema: S(), run: revenueSummary },
  { name: "slack_list_channels", description: "Slack (Acme LLC): list channels.", inputSchema: S(), run: () => channels },
  { name: "slack_channel_history", description: "Slack (Acme LLC): newest messages of a channel (name like 'support' or id).", inputSchema: S({ channel: str("Channel name or id"), limit: lim }, ["channel"]),
    run: (a) => { const ch = channels.find((c) => c.id === a.channel || c.name === String(a.channel).replace(/^#/, "")); return ch ? take(messages[ch.id] ?? [], a) : { error: "channel_not_found" }; } },
  { name: "slack_search_messages", description: "Slack (Acme LLC): search message text in all channels.", inputSchema: S({ query: str("Text to find") }, ["query"]), run: (a) => slackSearch(String(a.query)) },
  { name: "drive_search_files", description: "Google Drive (Acme LLC): search files by name or content; returns metadata.", inputSchema: S({ query: str("Words to find (empty = all)") }),
    run: (a) => files.filter((f) => !a.query || q(f.name + " " + f.body).includes(q(a.query))).map(driveMeta) },
  { name: "drive_get_file_text", description: "Google Drive (Acme LLC): plain text of one file by id.", inputSchema: S({ fileId: str("File id") }, ["fileId"]),
    run: (a) => { const f = files.find((x) => x.id === a.fileId); return f ? { ...driveMeta(f), text: f.body } : { error: "file_not_found" }; } },
  { name: "hubspot_list_contacts", description: "HubSpot CRM (Acme LLC): list contacts, optional text filter.", inputSchema: S({ query: str("Name, email or company"), limit: lim }),
    run: (a) => take(contacts.filter((c) => !a.query || q(Object.values(c.properties).join(" ")).includes(q(a.query))), a) },
  { name: "hubspot_list_deals", description: "HubSpot CRM (Acme LLC): list deals, optional stage (e.g. contractsent, closedwon, closedlost).", inputSchema: S({ stage: str("Deal stage"), limit: lim }),
    run: (a) => take(deals.filter((d) => !a.stage || d.properties.dealstage === a.stage), a) },
  { name: "postgres_list_tables", description: "Orders database (PostgreSQL, Acme LLC): list tables and row counts.", inputSchema: S(), run: () => listTables() },
  { name: "postgres_describe_table", description: "Orders database (PostgreSQL, Acme LLC): columns of one table (products, orders, order_lines).", inputSchema: S({ table: str("Table name") }, ["table"]), run: (a) => describe(String(a.table)) },
  { name: "gmail_send_email", action: true, description: "Mock mailbox (fictional): send an email. Records the call only; nothing is sent.",
    inputSchema: S({ to: str("Recipient address"), subject: str("Subject"), body: str("Plain text body") }, ["to", "subject", "body"]), run: record("gmail_send_email") },
  { name: "gmail_create_draft", action: true, description: "Mock mailbox (fictional): save a draft. Records the call only; nothing is sent or stored in a mailbox.",
    inputSchema: S({ to: str("Recipient address"), subject: str("Subject"), body: str("Plain text body"), delay_ms: { type: "integer", minimum: 0, maximum: 8000, description: "Answer this much later (QA of retries)" } }, ["to", "subject", "body"]), run: record("gmail_create_draft") },
  { name: "blog_publish_article", action: true, description: "Mock blog (fictional): publish an article. Records the call only; nothing is published.",
    inputSchema: S({ title: str("Article title"), text: str("Article text") }, ["title", "text"]), run: record("blog_publish_article") },
  { name: "facebook_reply_to_comment", action: true, description: "Mock Facebook page (fictional): reply to a comment. Records the call only; nothing is posted.",
    inputSchema: S({ comment_id: str("Comment id"), message: str("Reply text") }, ["comment_id", "message"]), run: record("facebook_reply_to_comment") },
  { name: "metaads_update_campaign_budget", action: true, description: "Mock Meta Ads account (fictional): change a campaign's daily budget. Records the call only; nothing changes.",
    inputSchema: S({ campaign_id: str("Campaign id"), daily_budget_cents: { type: "integer", minimum: 100, description: "New daily budget in cents" } }, ["campaign_id", "daily_budget_cents"]), run: record("metaads_update_campaign_budget") },
  { name: "postgres_select", description: "Orders database (PostgreSQL, Acme LLC): run ONE read-only SELECT (read-only transaction, max 200 rows).", inputSchema: S({ sql: str("One SELECT statement") }, ["sql"]), run: (a) => select(String(a.sql)) },
];

async function rpc(msg: { id?: unknown; method?: string; params?: Args }): Promise<unknown | null> {
  try {
    return await rpcInner(msg);
  } catch (e) {
    if (e instanceof ResourceError) return { jsonrpc: "2.0", id: msg.id ?? null, error: { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) } };
    throw e;
  }
}
async function rpcInner(msg: { id?: unknown; method?: string; params?: Args }): Promise<unknown | null> {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: msg.id, result });
  const err = (code: number, message: string) => ({ jsonrpc: "2.0", id: msg.id ?? null, error: { code, message } });
  if (msg.id === undefined) return null; // notification
  switch (msg.method) {
    case "initialize":
      return ok({ protocolVersion: (msg.params?.protocolVersion as string) ?? "2025-06-18", capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } }, serverInfo: { name: "acme-data-sources", version: VERSION }, instructions: "Acme LLC company data: Stripe, Slack, Google Drive, HubSpot and the orders database (PostgreSQL). Synthetic, read only. Tools query the sources live; resources are text snapshots (Drive docs, Slack transcripts per day, Stripe and HubSpot reports) for ingestion." });
    case "ping": return ok({});
    case "tools/list":
      return ok({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema,
        annotations: t.action ? { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } : { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } })) });
    case "resources/list": return ok(listResources(msg.params?.cursor));
    case "resources/templates/list": return ok({ resourceTemplates: [] });
    case "resources/read": return ok(readResource(msg.params?.uri));
    case "tools/call": {
      const t = TOOLS.find((x) => x.name === msg.params?.name);
      if (!t) return err(-32602, "Unknown tool");
      const out = await t.run((msg.params?.arguments as Args) ?? {});
      return ok({ content: [{ type: "text", text: JSON.stringify(out, null, 1) }], structuredContent: Array.isArray(out) ? { items: out } : out, isError: false });
    }
    default: return err(-32601, "Method not found");
  }
}

// ───────── HTTP ─────────
const send = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const readBody = (req: IncomingMessage) => new Promise<string>((ok, no) => {
  let s = ""; req.on("data", (d) => { s += d; if (s.length > 1e6) req.destroy(); }); req.on("end", () => ok(s)); req.on("error", no);
});

createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://x");
  const p = u.pathname.replace(/\/+$/, "") || "/";
  try {
    if (p === "/mcp") {
      if (req.method === "DELETE") return send(res, 200, {});
      if (req.method === "GET") return send(res, 405, { error: "SSE stream not offered" }, { allow: "POST, DELETE" });
      if (req.method !== "POST") return send(res, 405, {});
      const body = JSON.parse(await readBody(req));
      const session = (req.headers["mcp-session-id"] as string) || randomUUID();
      const out = Array.isArray(body) ? (await Promise.all(body.map(rpc))).filter(Boolean) : await rpc(body);
      if (out === null || (Array.isArray(out) && out.length === 0)) { res.writeHead(202, { "mcp-session-id": session }); return res.end(); }
      return send(res, 200, out, { "mcp-session-id": session });
    }
    if (req.method !== "GET") return send(res, 405, { error: "read only" });
    if (p === "/jarvis/actions") return send(res, 200, { mock: true, actions });
    // C373 Jarvis: fictional page comments (Italian), one offensive, for the comment-reply workflow
    if (p === "/meta/v1/comments") return send(res, 200, { mock: true, data: COMMENTS });
    const base = `${u.pathname}`;
    // Stripe
    if (p === "/stripe/v1/customers") return send(res, 200, stripeList(customers, u.searchParams, base, (c) => !u.searchParams.get("email") || c.email === u.searchParams.get("email")));
    if (p === "/stripe/v1/subscriptions") return send(res, 200, stripeList(subscriptions, u.searchParams, base, (s) => !u.searchParams.get("status") || s.status === u.searchParams.get("status")));
    if (p === "/stripe/v1/invoices") return send(res, 200, stripeList(invoices.slice().reverse(), u.searchParams, base, (i) => !u.searchParams.get("customer") || i.customer === u.searchParams.get("customer")));
    if (p === "/stripe/v1/charges") return send(res, 200, stripeList(charges.slice().reverse(), u.searchParams, base, (c) => !u.searchParams.get("customer") || c.customer === u.searchParams.get("customer")));
    const one = /^\/stripe\/v1\/(customers|subscriptions|invoices|charges)\/([\w]+)$/.exec(p);
    if (one) { const rows = { customers, subscriptions, invoices, charges }[one[1] as "customers"] as { id: string }[]; const r = rows.find((x) => x.id === one[2]); return r ? send(res, 200, r) : send(res, 404, { error: { type: "invalid_request_error", code: "resource_missing" } }); }
    // Slack
    if (p === "/slack/api/conversations.list") return send(res, 200, { ok: true, channels });
    if (p === "/slack/api/conversations.history") { const id = u.searchParams.get("channel") ?? ""; return send(res, 200, messages[id] ? { ok: true, messages: messages[id], has_more: false } : { ok: false, error: "channel_not_found" }); }
    if (p === "/slack/api/search.messages") return send(res, 200, { ok: true, messages: { matches: slackSearch(u.searchParams.get("query") ?? "") } });
    // Drive
    if (p === "/drive/v3/files") return send(res, 200, { kind: "drive#fileList", files: files.filter((f) => !u.searchParams.get("q") || q(f.name + f.body).includes(q(u.searchParams.get("q")))).map(driveMeta) });
    const f = /^\/drive\/v3\/files\/([\w]+)(\/export)?$/.exec(p);
    if (f) { const file = files.find((x) => x.id === f[1]); if (!file) return send(res, 404, { error: { code: 404 } }); return f[2] ? (res.writeHead(200, { "content-type": "text/plain" }), res.end(file.body)) : send(res, 200, driveMeta(file)); }
    // HubSpot
    if (p === "/hubspot/crm/v3/objects/contacts") return send(res, 200, { results: contacts, paging: null });
    if (p === "/hubspot/crm/v3/objects/deals") return send(res, 200, { results: deals, paging: null });
    if (p === "/" || p === "/healthz") return send(res, 200, { ok: true, name: "acme-data-sources", version: VERSION, seed: SEED, synthetic: true, counts: { customers: customers.length, subscriptions: subscriptions.length, invoices: invoices.length, charges: charges.length, contacts: contacts.length, deals: deals.length, files: files.length, slack_messages: Object.values(messages).flat().length }, resources: { total: resourceCount, page_size: PAGE_SIZE, by_collection: resourceCounts() }, mcp: "/mcp", tools: TOOLS.map((t) => t.name) });
    return send(res, 404, { error: "not_found" });
  } catch (e) {
    return send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: String((e as Error).message).slice(0, 200) } });
  }
}).listen(PORT, () => console.log(`acme-data-sources ${VERSION} on :${PORT} (seed ${SEED})`));
seed().then((m) => console.log(`orders db: ${m}`), (e) => console.error(`orders db seed failed: ${String(e).slice(0, 200)}`));
