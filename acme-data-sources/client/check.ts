// Black-box check of a running acme-data-sources server over its /mcp URL (no keys needed).
// Usage: node client/check.ts [https://host/mcp]   (default http://localhost:8080/mcp, or ACME_MCP_URL)
// Lists every resource (following cursors), reads each one, then calls the tools. Exits 1 on the first failed check.
const url = process.argv[2] ?? process.env.ACME_MCP_URL ?? "http://localhost:8080/mcp";
let id = 0;
async function rpc<T = Record<string, unknown>>(method: string, params?: unknown): Promise<{ result?: T; error?: { code: number; message: string } }> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
  if (!r.ok) throw new Error(`${method}: HTTP ${r.status}`);
  return (await r.json()) as { result?: T; error?: { code: number; message: string } };
}
let failed = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? "ok  " : "FAIL"} ${what}`); if (!ok) failed++; };

interface Res { uri: string; name: string; mimeType: string; size: number; annotations?: { lastModified?: string }; _meta?: { collection: string; kind: string } }
const init = await rpc<{ capabilities: Record<string, unknown>; serverInfo: { version: string } }>("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "acme-check", version: "0" } });
check(!!init.result?.capabilities.resources && !!init.result?.capabilities.tools, `initialize: version ${init.result?.serverInfo.version}, capabilities tools + resources`);

const tools = await rpc<{ tools: { name: string }[] }>("tools/list");
check(tools.result?.tools.length === 18, `tools/list: ${tools.result?.tools.length} tools (expect 15 read + 3 record-only actions)`);

const resources: Res[] = [];
let cursor: string | undefined;
let pages = 0;
do {
  const page = await rpc<{ resources: Res[]; nextCursor?: string }>("resources/list", cursor ? { cursor } : {});
  if (!page.result) { check(false, `resources/list page ${pages + 1}: ${page.error?.message}`); break; }
  resources.push(...page.result.resources);
  cursor = page.result.nextCursor;
  pages++;
} while (cursor);
check(resources.length > 0 && new Set(resources.map((r) => r.uri)).size === resources.length, `resources/list: ${resources.length} resources in ${pages} pages, unique uris`);

const counts: Record<string, number> = {};
let bad = 0;
for (const r of resources) {
  counts[r._meta?.collection ?? "?"] = (counts[r._meta?.collection ?? "?"] ?? 0) + 1;
  const got = await rpc<{ contents: { uri: string; mimeType: string; text: string }[] }>("resources/read", { uri: r.uri });
  const c = got.result?.contents[0];
  if (!c || c.uri !== r.uri || c.mimeType !== r.mimeType || Buffer.byteLength(c.text) !== r.size || !r.annotations?.lastModified || !r._meta?.kind) { bad++; console.log(`  bad: ${r.uri}`); }
}
check(bad === 0, `resources/read: all ${resources.length} read back with matching uri, mimeType, size, lastModified, _meta`);
for (const [k, v] of Object.entries(counts).sort()) console.log(`  ${String(v).padStart(3)}  ${k}`);

const nf = await rpc("resources/read", { uri: "acme://nope" });
check(nf.error?.code === -32002, "resources/read unknown uri: error -32002");
const bc = await rpc("resources/list", { cursor: "bogus" });
check(bc.error?.code === -32602, "resources/list bad cursor: error -32602");

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = await rpc<{ content: { text: string }[]; isError: boolean }>("tools/call", { name, arguments: args });
  return r.result && !r.result.isError ? r.result.content[0]!.text : undefined;
};
check(/mrr_cents/.test((await call("stripe_revenue_summary")) ?? ""), "tools/call stripe_revenue_summary");
check(/"id"/.test((await call("drive_search_files", { query: "refund" })) ?? ""), "tools/call drive_search_files");
check(/#4411/.test((await call("slack_channel_history", { channel: "support" })) ?? ""), "tools/call slack_channel_history");
check(/"deals?name"|dealname/.test((await call("hubspot_list_deals", { limit: 3 })) ?? ""), "tools/call hubspot_list_deals");
const pg = await call("postgres_list_tables");
check(pg !== undefined && /"table": "orders",\s*"rows": \d+/.test(pg), "tools/call postgres_list_tables (needs the database: orders row count)");
process.exit(failed ? 1 : 0);
