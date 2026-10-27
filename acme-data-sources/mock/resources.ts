// MCP resources for the Acme LLC mock: the same synthetic data as the REST faces and the read-only tools, as text resources
// a knowledge pipeline can list and read. Four collections:
//   Google Drive docs        acme://drive/<folder>/<id>        text/markdown   kind document         collection "Acme LLC/Finance" …
//   Slack channel transcripts acme://slack/<channel>/<date>    text/plain      kind chat_transcript  collection "#support" …
//   Stripe reports           acme://stripe/<report>[/<month>]  text/markdown   kind report           collection "Stripe"
//   HubSpot pipeline report  acme://hubspot/pipeline           text/markdown   kind report           collection "HubSpot"
// Everything is derived from data.ts (fixed clock, fixed seed) with no Date.now() and no randomness, so every restart serves
// the same bytes and the same lastModified values. Folder names in Drive URIs are percent-encoded per path segment.
import { channels, charges, customers, deals, files, invoices, messages, NOW, subscriptions, userNames } from "./data.ts";

export type ResourceKind = "document" | "chat_transcript" | "report";
export interface ResourceEntry {
  uri: string; name: string; title: string; description: string; mimeType: string; size: number;
  annotations: { audience: ["user", "assistant"]; priority: number; lastModified: string };
  _meta: { collection: string; kind: ResourceKind };
}
interface Built { entry: ResourceEntry; text: string }

/** JSON-RPC error with the MCP code (-32602 invalid params, -32002 resource not found). */
export class ResourceError extends Error {
  code: number;
  data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

// ───────── small formatters (no Intl: the output must not depend on the ICU build) ─────────
const iso = (sec: number) => new Date(sec * 1000).toISOString();
const NOW_ISO = iso(NOW);
const group = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const eur = (cents: number) => `${cents < 0 ? "-" : ""}€${group(Math.floor(Math.abs(cents) / 100))}.${String(Math.abs(cents) % 100).padStart(2, "0")}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const monthLabel = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(0, 4)}`;
const cell = (s: unknown) => String(s).replace(/\|/g, "/").replace(/\s+/g, " ");
const table = (head: string[], rows: unknown[][]) =>
  [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`, ...rows.map((r) => `| ${r.map(cell).join(" | ")} |`)].join("\n");

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v ?? 0);
const s = (v: unknown) => String(v ?? "");
const customerName = (id: unknown) => customers.find((c) => c.id === id)?.name ?? s(id);

const built: Built[] = [];
function add(uri: string, name: string, description: string, mimeType: string, collection: string, kind: ResourceKind, lastModified: string, priority: number, text: string) {
  built.push({
    text,
    entry: {
      uri, name, title: name, description, mimeType, size: Buffer.byteLength(text, "utf8"),
      annotations: { audience: ["user", "assistant"], priority, lastModified },
      _meta: { collection, kind },
    },
  });
}

// ───────── Google Drive ─────────
for (const f of files) {
  const uri = `acme://drive/${f.folder.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(f.id)}`;
  const text = [
    `# ${f.name}`, "",
    `- Folder: ${f.folder}`, `- Owner: ${f.owners[0]?.displayName ?? "unknown"}`, `- Modified: ${f.modifiedTime}`, `- Type: ${f.mimeType.replace("application/vnd.google-apps.", "Google ")}`, `- Link: ${f.webViewLink}`, "",
    ...f.body.split(/(?<=[.!?])\s+(?=[A-Z0-9€])/).map((x) => x.trim()).filter(Boolean).map((x) => `- ${x}`), "",
  ].join("\n");
  add(uri, f.name, `Google Drive document in ${f.folder}, owner ${f.owners[0]?.displayName ?? "unknown"}.`, "text/markdown", f.folder, "document", f.modifiedTime, 0.8, text);
}

// ───────── Slack transcripts: one resource per channel per UTC day ─────────
for (const ch of channels) {
  const chronological = (messages[ch.id] ?? []).slice().reverse();
  const byDay = new Map<string, typeof chronological>();
  for (const m of chronological) {
    const day = iso(Number(m.ts.split(".")[0])).slice(0, 10);
    byDay.set(day, [...(byDay.get(day) ?? []), m]);
  }
  for (const [day, msgs] of byDay) {
    const lines = msgs.map((m) => `${iso(Number(m.ts.split(".")[0])).slice(11, 16)} ${userNames[m.user] ?? m.user}: ${m.text}`);
    const last = iso(Number(msgs[msgs.length - 1]!.ts.split(".")[0]));
    add(`acme://slack/${encodeURIComponent(ch.name)}/${day}`, `#${ch.name} ${day}`, `Slack #${ch.name} on ${day} (times UTC): ${msgs.length} message${msgs.length === 1 ? "" : "s"}. Channel topic: ${ch.topic.value}`, "text/plain", `#${ch.name}`, "chat_transcript", last, 0.5, lines.join("\n") + "\n");
  }
}

// ───────── Stripe reports ─────────
const inv = invoices as Row[];
const chg = charges as Row[];
const subs = subscriptions as Row[];
const monthKey = (sec: number) => iso(sec).slice(0, 7);
const months = [...new Set(inv.map((i) => monthKey(n(i.created))))].sort();
for (const mk of months) {
  const mi = inv.filter((i) => monthKey(n(i.created)) === mk);
  const mc = chg.filter((c) => monthKey(n(c.created)) === mk);
  const sum = (rows: Row[], k: string) => rows.reduce((a, r) => a + n(r[k]), 0);
  const failed = mc.filter((c) => c.status === "failed");
  const byCode: Record<string, number> = {};
  for (const c of failed) byCode[s(c.failure_code)] = (byCode[s(c.failure_code)] ?? 0) + 1;
  const newCustomers = customers.filter((c) => monthKey(c.created) === mk).length;
  const lines = [
    `# Stripe revenue summary – ${monthLabel(mk)}`, "",
    "Acme LLC, currency EUR, Stripe test mode (synthetic data).", "",
    table(["Metric", "Value"], [
      ["Invoices issued", mi.length], ["Invoiced total", eur(sum(mi, "amount_due"))], ["Collected", eur(sum(mi, "amount_paid"))],
      ["Outstanding (open invoices)", eur(sum(mi.filter((i) => i.status === "open"), "amount_remaining"))],
      ["Draft (trial) invoices", `${mi.filter((i) => i.status === "draft").length} (${eur(sum(mi.filter((i) => i.status === "draft"), "amount_due"))})`],
      ["Successful charges", mc.filter((c) => c.status === "succeeded").length], ["Failed charges", failed.length],
      ["Refunded charges", mc.filter((c) => c.refunded === true).length], ["New customers", newCustomers],
    ]), "",
  ];
  if (failed.length) {
    lines.push("## Failed charges", "", table(["Invoice", "Customer", "Amount", "Failure code"], failed.map((c) => [s(c.description).replace("Invoice ", ""), customerName(c.customer), eur(n(c.amount)), s(c.failure_code)])), "");
    lines.push(`Failure codes: ${Object.entries(byCode).sort().map(([k, v]) => `${k} ×${v}`).join(", ")}.`, "");
  }
  if (mk === months[months.length - 1]) {
    // Subscriptions have no history, so the recurring-revenue snapshot belongs to the latest month only.
    let mrr = 0;
    for (const sub of subs.filter((x) => x.status === "active" || x.status === "past_due")) {
      const it = (sub.items as { data: { quantity: number; price: { unit_amount: number; recurring: { interval: string } } }[] }).data[0]!;
      mrr += it.price.recurring.interval === "year" ? (it.price.unit_amount * it.quantity) / 12 : it.price.unit_amount * it.quantity;
    }
    const byStatus: Record<string, number> = {};
    for (const x of subs) byStatus[s(x.status)] = (byStatus[s(x.status)] ?? 0) + 1;
    lines.push(`## Recurring revenue snapshot (as of ${NOW_ISO.slice(0, 10)})`, "",
      table(["Metric", "Value"], [["MRR (active + past due)", eur(Math.round(mrr))], ["ARR", eur(Math.round(mrr) * 12)], ["Customers", customers.length],
        ["Subscriptions by status", Object.entries(byStatus).sort().map(([k, v]) => `${k} ${v}`).join(", ")]]), "");
  }
  const monthEnd = Date.UTC(Number(mk.slice(0, 4)), Number(mk.slice(5, 7)), 1) / 1000 - 1;
  add(`acme://stripe/revenue/${mk}`, `Stripe revenue summary ${mk}`, `Monthly revenue summary for ${monthLabel(mk)}: invoices, collections, failed charges.`, "text/markdown", "Stripe", "report", iso(Math.min(monthEnd, NOW)), 0.7, lines.join("\n"));
}

{
  const open = inv.filter((i) => i.status === "open").sort((a, b) => n(a.created) - n(b.created));
  const rows = open.map((i) => {
    const ch = chg.find((c) => c.invoice === i.id);
    const sub = subs.find((x) => x.id === i.subscription);
    return [s(i.number), s(i.customer_name), eur(n(i.amount_remaining)), n(i.attempt_count), iso(n(i.created)).slice(0, 10), Math.floor((NOW - n(i.created)) / 86400), s(ch?.failure_code ?? "none"), s(sub?.status ?? "")];
  });
  const text = [
    "# Stripe past-due invoices", "",
    `As of ${NOW_ISO.slice(0, 10)}. ${open.length} open invoices, ${eur(open.reduce((a, i) => a + n(i.amount_remaining), 0))} outstanding. Acme LLC, EUR, synthetic data.`, "",
    table(["Invoice", "Customer", "Amount due", "Attempts", "Issued", "Days open", "Failure code", "Subscription"], rows), "",
  ].join("\n");
  add("acme://stripe/past-due-invoices", "Stripe past-due invoices", "Open invoices that failed to collect, with failure code and age.", "text/markdown", "Stripe", "report", NOW_ISO, 0.9, text);
}

{
  const paid = new Map<string, number>();
  for (const i of inv) paid.set(s(i.customer), (paid.get(s(i.customer)) ?? 0) + n(i.amount_paid));
  const top = [...paid.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 10);
  const rows = top.map(([id, total], idx) => {
    const c = customers.find((x) => x.id === id)!;
    const sub = subs.find((x) => x.customer === id);
    const plan = (sub?.items as { data: { price: { nickname: string } }[] } | undefined)?.data[0]?.price.nickname ?? "";
    return [idx + 1, c.name, c.id, c.metadata.segment, plan, s(sub?.status ?? ""), eur(total)];
  });
  const text = [
    "# Stripe top customers", "",
    `Top 10 customers by cash collected over the last six months (as of ${NOW_ISO.slice(0, 10)}). Acme LLC, EUR, synthetic data.`, "",
    table(["Rank", "Customer", "Stripe id", "Segment", "Plan", "Subscription", "Collected"], rows), "",
  ].join("\n");
  add("acme://stripe/top-customers", "Stripe top customers", "Top 10 customers by collected revenue, with segment, plan and subscription status.", "text/markdown", "Stripe", "report", NOW_ISO, 0.6, text);
}

// ───────── HubSpot pipeline ─────────
{
  const STAGES: [string, string][] = [["appointmentscheduled", "Appointment scheduled"], ["qualifiedtobuy", "Qualified to buy"], ["presentationscheduled", "Presentation scheduled"], ["decisionmakerboughtin", "Decision maker bought in"], ["contractsent", "Contract sent"]];
  const open = deals.filter((d) => !d.properties.dealstage.startsWith("closed"));
  const amt = (d: (typeof deals)[number]) => Number(d.properties.amount) * 100;
  const lines = [
    "# HubSpot pipeline report – open deals by stage", "",
    `As of ${NOW_ISO.slice(0, 10)}. ${open.length} open deals worth ${eur(open.reduce((a, d) => a + amt(d), 0))}; pipeline "default". Acme LLC, EUR, synthetic data.`, "",
    table(["Stage", "Deals", "Value"], STAGES.map(([id, label]) => { const ds = open.filter((d) => d.properties.dealstage === id); return [label, ds.length, eur(ds.reduce((a, d) => a + amt(d), 0))]; })), "",
  ];
  for (const [id, label] of STAGES) {
    const ds = open.filter((d) => d.properties.dealstage === id).sort((a, b) => (a.properties.closedate < b.properties.closedate ? -1 : a.properties.closedate > b.properties.closedate ? 1 : 0));
    if (!ds.length) continue;
    lines.push(`## ${label}`, "", table(["Deal", "Amount", "Expected close", "Owner"], ds.map((d) => [d.properties.dealname, eur(amt(d)), d.properties.closedate, d.properties.hubspot_owner_id])), "");
  }
  const won = deals.filter((d) => d.properties.dealstage === "closedwon"), lost = deals.filter((d) => d.properties.dealstage === "closedlost");
  lines.push("## Closed", "", table(["Outcome", "Deals", "Value"], [["Won", won.length, eur(won.reduce((a, d) => a + amt(d), 0))], ["Lost", lost.length, eur(lost.reduce((a, d) => a + amt(d), 0))]]), "");
  add("acme://hubspot/pipeline", "HubSpot pipeline report", "Open deals by stage with amounts, expected close dates and owners; closed won and lost totals.", "text/markdown", "HubSpot", "report", NOW_ISO, 0.9, lines.join("\n"));
}

// ───────── order and lookup ─────────
const KIND_ORDER: Record<ResourceKind, number> = { document: 0, chat_transcript: 1, report: 2 };
built.sort((a, b) => KIND_ORDER[a.entry._meta.kind] - KIND_ORDER[b.entry._meta.kind] || (a.entry.uri < b.entry.uri ? -1 : a.entry.uri > b.entry.uri ? 1 : 0));
const byUri = new Map(built.map((b) => [b.entry.uri, b]));

export const PAGE_SIZE = Math.max(1, Number(process.env.RESOURCES_PAGE_SIZE ?? 10));
export const resourceCount = built.length;
export function resourceCounts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const b of built) out[b.entry._meta.collection] = (out[b.entry._meta.collection] ?? 0) + 1;
  return out;
}

// The cursor is opaque to clients. It carries the offset and the list size, so a cursor from a different list is refused.
const encodeCursor = (offset: number) => Buffer.from(`acme-res:${built.length}:${offset}`).toString("base64url");
function decodeCursor(c: string): number {
  const m = /^acme-res:(\d+):(\d+)$/.exec(Buffer.from(c, "base64url").toString("utf8"));
  if (!m || Number(m[1]) !== built.length || Number(m[2]) > built.length) throw new ResourceError(-32602, "Invalid cursor");
  return Number(m[2]);
}

/** MCP resources/list: one page of at most `pageSize` entries; `nextCursor` only when more follow. */
export function listResources(cursor?: unknown, pageSize = PAGE_SIZE): { resources: ResourceEntry[]; nextCursor?: string } {
  if (cursor !== undefined && typeof cursor !== "string") throw new ResourceError(-32602, "cursor must be a string");
  const start = cursor === undefined ? 0 : decodeCursor(cursor);
  const end = Math.min(built.length, start + pageSize);
  return { resources: built.slice(start, end).map((b) => b.entry), ...(end < built.length ? { nextCursor: encodeCursor(end) } : {}) };
}

/** MCP resources/read for one uri. Unknown uri: -32002 (resource not found). */
export function readResource(uri: unknown): { contents: { uri: string; mimeType: string; text: string; _meta: ResourceEntry["_meta"] }[] } {
  if (typeof uri !== "string" || !uri) throw new ResourceError(-32602, "uri is required");
  const b = byUri.get(uri);
  if (!b) throw new ResourceError(-32002, "Resource not found", { uri });
  return { contents: [{ uri: b.entry.uri, mimeType: b.entry.mimeType, text: b.text, _meta: b.entry._meta }] };
}
