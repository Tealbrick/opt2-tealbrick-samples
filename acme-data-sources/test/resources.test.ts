// MCP resources of the Acme mock: list paging, read, determinism, shape. No database and no network needed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { listResources, type ResourceEntry, ResourceError, readResource, resourceCount, resourceCounts } from "../mock/resources.ts";

function all(pageSize: number): { entries: ResourceEntry[]; pages: number } {
  const entries: ResourceEntry[] = [];
  let cursor: string | undefined;
  let pages = 0;
  do {
    const page = listResources(cursor, pageSize);
    entries.push(...page.resources);
    cursor = page.nextCursor;
    pages++;
  } while (cursor);
  return { entries, pages };
}

test("list pages with cursors and returns every resource exactly once", () => {
  const { entries, pages } = all(10);
  assert.equal(entries.length, resourceCount);
  assert.equal(new Set(entries.map((e) => e.uri)).size, resourceCount);
  assert.equal(pages, Math.ceil(resourceCount / 10));
  assert.deepEqual(all(resourceCount).entries, entries, "page size does not change the order");
  assert.equal(all(resourceCount).pages, 1);
  assert.equal(listResources(undefined, resourceCount).nextCursor, undefined, "no nextCursor on the last page");
});

test("an invalid cursor is refused with -32602", () => {
  for (const bad of ["nope", Buffer.from("acme-res:1:1").toString("base64url"), Buffer.from(`acme-res:${resourceCount}:9999`).toString("base64url")]) {
    assert.throws(() => listResources(bad), (e) => e instanceof ResourceError && e.code === -32602);
  }
  assert.throws(() => listResources(7 as unknown as string), (e) => e instanceof ResourceError && e.code === -32602);
});

test("every entry has the contract fields and reads back with the same size", () => {
  for (const e of all(10).entries) {
    assert.match(e.uri, /^acme:\/\/(drive|slack|stripe|hubspot)\//);
    assert.ok(["text/markdown", "text/plain"].includes(e.mimeType));
    assert.ok(["document", "chat_transcript", "report"].includes(e._meta.kind));
    assert.ok(e._meta.collection.length > 0);
    assert.match(e.annotations.lastModified, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const r = readResource(e.uri).contents[0]!;
    assert.equal(r.uri, e.uri);
    assert.equal(r.mimeType, e.mimeType);
    assert.equal(Buffer.byteLength(r.text, "utf8"), e.size);
    assert.deepEqual(r._meta, e._meta);
    assert.ok(!r.text.includes("\u0000"));
  }
});

test("collections and kinds match the brief", () => {
  const entries = all(10).entries;
  const kindOf = (prefix: string) => new Set(entries.filter((e) => e.uri.startsWith(prefix)).map((e) => e._meta.kind));
  assert.deepEqual([...kindOf("acme://drive/")], ["document"]);
  assert.deepEqual([...kindOf("acme://slack/")], ["chat_transcript"]);
  assert.deepEqual([...kindOf("acme://stripe/")], ["report"]);
  assert.deepEqual([...kindOf("acme://hubspot/")], ["report"]);
  const counts = resourceCounts();
  assert.equal(counts["Acme LLC/Finance"], 1);
  assert.ok(counts["#support"]! >= 2);
  assert.ok(counts.Stripe! >= 3);
  assert.equal(counts.HubSpot, 1);
  const drive = entries.find((e) => e._meta.collection === "Acme LLC/Finance")!;
  assert.match(drive.uri, /^acme:\/\/drive\/Acme%20LLC\/Finance\/[A-Za-z0-9]+$/);
});

test("Slack transcripts are 'HH:MM name: text' lines in time order, one UTC day each", () => {
  const slack = all(10).entries.filter((e) => e.uri.startsWith("acme://slack/"));
  for (const e of slack) {
    const day = /\/(\d{4}-\d{2}-\d{2})$/.exec(e.uri)![1]!;
    const lines = readResource(e.uri).contents[0]!.text.trimEnd().split("\n");
    const times = lines.map((l) => {
      const m = /^(\d\d:\d\d) [A-Z][a-z]+ [A-Z][a-z]+: .+/.exec(l);
      assert.ok(m, `bad line: ${l}`);
      return m[1]!;
    });
    assert.deepEqual(times, [...times].sort());
    assert.ok(e.annotations.lastModified.startsWith(day));
  }
});

test("Stripe and HubSpot reports carry the numbers of the live tools", () => {
  const pastDue = readResource("acme://stripe/past-due-invoices").contents[0]!.text;
  assert.match(pastDue, /ACME-1029/);
  assert.match(pastDue, /ACME-1144/);
  const rev = all(10).entries.filter((e) => e.uri.startsWith("acme://stripe/revenue/"));
  assert.ok(rev.length >= 3);
  assert.match(readResource(rev[rev.length - 1]!.uri).contents[0]!.text, /MRR/);
  assert.match(readResource("acme://hubspot/pipeline").contents[0]!.text, /Contract sent/);
});

test("content is deterministic: a fresh process serves the same bytes", async () => {
  const { execFileSync } = await import("node:child_process");
  const snapshot = `import { listResources, readResource } from "./mock/resources.ts";
    const out = []; let c; do { const p = listResources(c, 5); for (const r of p.resources) out.push([r, readResource(r.uri)]); c = p.nextCursor; } while (c);
    process.stdout.write(JSON.stringify(out));`;
  const run = () => execFileSync(process.execPath, ["--input-type=module", "-e", snapshot], { cwd: new URL("..", import.meta.url), encoding: "utf8", maxBuffer: 1 << 24 });
  const a = run();
  assert.equal(run(), a);
  assert.equal(a, JSON.stringify(all(5).entries.map((r) => [r, readResource(r.uri)])));
});

test("unknown or missing uri: -32002 / -32602", () => {
  assert.throws(() => readResource("acme://nope"), (e) => e instanceof ResourceError && e.code === -32002);
  assert.throws(() => readResource(undefined), (e) => e instanceof ResourceError && e.code === -32602);
});
