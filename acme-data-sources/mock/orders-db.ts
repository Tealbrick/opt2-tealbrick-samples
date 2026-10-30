// Acme LLC orders database (PostgreSQL): synthetic products, orders and order lines, seeded once and deterministically.
// Exposed read-only as MCP tools (list tables, describe, SELECT). DATABASE_URL comes from the Railway Postgres service.
import pg from "pg";
import { customers, NOW, SEED } from "./data.ts";

const url = process.env.DATABASE_URL;
export const pool = url ? new pg.Pool({ connectionString: url, max: 4, statement_timeout: 5000 }) : null;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRODUCTS = [
  ["ACM-HUB-01", "Acme Sensor Hub", "hardware", 34900], ["ACM-SNS-T1", "Temperature sensor T1", "hardware", 4900],
  ["ACM-SNS-H2", "Humidity sensor H2", "hardware", 5900], ["ACM-SNS-M3", "Motion sensor M3", "hardware", 3900],
  ["ACM-GW-LTE", "LTE gateway", "hardware", 21900], ["ACM-MNT-KIT", "Wall mount kit", "accessory", 1900],
  ["ACM-BAT-6", "Battery pack (6)", "accessory", 2400], ["ACM-CBL-5M", "Sensor cable 5 m", "accessory", 1200],
  ["ACM-INST", "On-site installation", "service", 49000], ["ACM-TRN", "Team training (half day)", "service", 89000],
  ["ACM-SUP-PRM", "Premium support (year)", "service", 120000], ["ACM-CAL", "Sensor calibration", "service", 15000],
] as const;

export async function seed(): Promise<string> {
  if (!pool) return "no DATABASE_URL";
  const c = await pool.connect();
  try {
    await c.query(`CREATE TABLE IF NOT EXISTS products (sku text PRIMARY KEY, name text NOT NULL, category text NOT NULL, unit_price_cents int NOT NULL, active boolean NOT NULL DEFAULT true);
      CREATE TABLE IF NOT EXISTS orders (id int PRIMARY KEY, order_number text UNIQUE NOT NULL, customer_name text NOT NULL, stripe_customer_id text, status text NOT NULL, channel text NOT NULL, created_at timestamptz NOT NULL, total_cents int NOT NULL);
      CREATE TABLE IF NOT EXISTS order_lines (order_id int REFERENCES orders(id), line int, sku text REFERENCES products(sku), quantity int NOT NULL, line_total_cents int NOT NULL, PRIMARY KEY (order_id, line));`);
    const { rows } = await c.query("SELECT count(*)::int AS n FROM orders");
    if (rows[0].n > 0) return `already seeded (${rows[0].n} orders)`;
    const rnd = mulberry32(SEED ^ 0x5eed);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
    await c.query("BEGIN");
    for (const [sku, name, cat, price] of PRODUCTS) await c.query("INSERT INTO products VALUES ($1,$2,$3,$4,$5)", [sku, name, cat, price, sku !== "ACM-SNS-H2"]);
    for (let id = 1; id <= 420; id++) {
      const cus = pick(customers);
      const created = new Date((NOW - Math.floor(rnd() * 180 * 86400)) * 1000);
      const status = pick(["fulfilled", "fulfilled", "fulfilled", "fulfilled", "shipped", "processing", "refunded", "cancelled"]);
      const lines = 1 + Math.floor(rnd() * 4);
      let total = 0;
      const ls: [number, number, string, number, number][] = [];
      for (let l = 1; l <= lines; l++) {
        const p = pick(PRODUCTS);
        const q = p[2] === "service" ? 1 : 1 + Math.floor(rnd() * 20);
        ls.push([id, l, p[0], q, q * p[3]]);
        total += q * p[3];
      }
      await c.query("INSERT INTO orders VALUES ($1,$2,$3,$4,$5,$6,$7,$8)", [id, `SO-${(24000 + id).toString()}`, cus.name, cus.id, status, pick(["web", "web", "sales", "partner"]), created, total]);
      for (const l of ls) await c.query("INSERT INTO order_lines VALUES ($1,$2,$3,$4,$5)", l);
    }
    await c.query("COMMIT");
    return "seeded 12 products, 420 orders";
  } catch (e) {
    await c.query("ROLLBACK").catch(() => {});
    throw e;
  } finally { c.release(); }
}

const TABLES = ["products", "orders", "order_lines"];

/** One read-only SELECT (or WITH … SELECT), inside a READ ONLY transaction, at most `max` rows. */
export async function select(sql: string, max = 200): Promise<unknown> {
  if (!pool) return { error: "database_not_configured" };
  const s = sql.trim().replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(s) || s.includes(";")) return { error: "only_single_select", message: "Send one SELECT statement." };
  const c = await pool.connect();
  try {
    await c.query("BEGIN READ ONLY");
    const r = await c.query(s);
    return { rowCount: r.rowCount, columns: r.fields.map((f) => f.name), rows: r.rows.slice(0, max), truncated: (r.rowCount ?? 0) > max };
  } catch (e) {
    return { error: "query_failed", message: String((e as Error).message).slice(0, 300) };
  } finally {
    await c.query("ROLLBACK").catch(() => {});
    c.release();
  }
}

export async function listTables(): Promise<unknown> {
  const out = [];
  for (const t of TABLES) out.push({ table: t, rows: ((await select(`SELECT count(*)::int AS n FROM ${t}`)) as { rows?: { n: number }[] }).rows?.[0]?.n ?? null });
  return { database: "acme_orders (PostgreSQL)", tables: out };
}

export async function describe(table: string): Promise<unknown> {
  if (!TABLES.includes(table)) return { error: "table_unknown", tables: TABLES };
  return select(`SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '${table}' ORDER BY ordinal_position`);
}
