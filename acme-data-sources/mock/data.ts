// Synthetic, deterministic data shaped like real API results (Stripe, Slack, Google Drive, HubSpot).
// Fictional company "Acme LLC" (B2B SaaS). No real people, companies, keys or money. Same seed → same bytes.

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

export const SEED = Number(process.env.MOCK_SEED ?? 20261024);
const rnd = mulberry32(SEED);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
const int = (lo: number, hi: number): number => lo + Math.floor(rnd() * (hi - lo + 1));

import { createHash } from "node:crypto";

// Stripe-looking ids from a hash (uses no PRNG draws, so the data itself does not change with the id format).
const idOf = (prefix: string, n: number): string => `${prefix}_${createHash("sha256").update(`${SEED}:${prefix}:${n}`).digest("base64url").replace(/[-_]/g, "").slice(0, 14)}`;
// Fixed "now" so the data does not drift between restarts.
export const NOW = Date.UTC(2026, 9, 24, 9, 0, 0) / 1000;
const DAY = 86400;

const FIRST = ["Ava", "Noah", "Mia", "Liam", "Zoe", "Ethan", "Lena", "Omar", "Ines", "Kai", "Nora", "Theo", "Priya", "Jonas", "Sofia", "Ravi", "Elena", "Marco", "Yuki", "Sam"];
const LAST = ["Fairbank", "Okafor", "Lindqvist", "Moreau", "Tanaka", "Brandt", "Castillo", "Novak", "Haddad", "Petrov", "Quinn", "Varga", "Sato", "Keller", "Duarte", "Bianchi", "Nilsen", "Abara", "Holm", "Reyes"];
const ORG_A = ["Bluefin", "Copperleaf", "Driftwood", "Emberline", "Foxglove", "Granite", "Harbor", "Ironbark", "Juniper", "Lumen", "Marlow", "Northgate", "Oakridge", "Pinecrest", "Quarry", "Redwing", "Saltmarsh", "Tidewater", "Umbra", "Willowby"];
const ORG_B = ["Logistics", "Dental", "Studios", "Analytics", "Foods", "Robotics", "Legal", "Clinics", "Outfitters", "Energy"];
const PLANS = [
  { id: "price_acme_starter_m", product: "prod_acme_starter", nickname: "Starter monthly", amount: 4900, interval: "month" },
  { id: "price_acme_team_m", product: "prod_acme_team", nickname: "Team monthly", amount: 19900, interval: "month" },
  { id: "price_acme_team_y", product: "prod_acme_team", nickname: "Team yearly", amount: 199000, interval: "year" },
  { id: "price_acme_scale_m", product: "prod_acme_scale", nickname: "Scale monthly", amount: 89900, interval: "month" },
] as const;

// ───────── Stripe ─────────
export interface Customer { id: string; object: "customer"; name: string; email: string; created: number; currency: "eur"; metadata: { company: string; segment: string }; delinquent: boolean; livemode: false }
export const customers: Customer[] = [];
export const subscriptions: Record<string, unknown>[] = [];
export const invoices: Record<string, unknown>[] = [];
export const charges: Record<string, unknown>[] = [];

for (let i = 1; i <= 36; i++) {
  const first = pick(FIRST), last = pick(LAST), company = `${pick(ORG_A)} ${pick(ORG_B)}`;
  const created = NOW - int(20, 400) * DAY;
  const cus: Customer = {
    id: idOf("cus", i), object: "customer", name: company, email: `${first}.${last}@${company.toLowerCase().replace(/\s+/g, "")}.example`.toLowerCase(),
    created, currency: "eur", metadata: { company, segment: pick(["smb", "smb", "mid-market", "enterprise"]) }, delinquent: false, livemode: false,
  };
  customers.push(cus);
  const plan = cus.metadata.segment === "enterprise" ? PLANS[3] : cus.metadata.segment === "mid-market" ? pick([PLANS[1], PLANS[2]]) : pick([PLANS[0], PLANS[0], PLANS[1]]);
  const status = pick(["active", "active", "active", "active", "active", "trialing", "past_due", "canceled"] as const);
  const sub = {
    id: idOf("sub", i), object: "subscription", customer: cus.id, status, created, currency: "eur", livemode: false,
    cancel_at_period_end: status === "active" && rnd() < 0.1,
    current_period_start: NOW - int(1, 27) * DAY, current_period_end: NOW + int(1, 28) * DAY,
    items: { object: "list", data: [{ id: idOf("si", i), object: "subscription_item", quantity: plan.interval === "year" ? 1 : int(1, 12), price: { id: plan.id, object: "price", product: plan.product, nickname: plan.nickname, unit_amount: plan.amount, currency: "eur", recurring: { interval: plan.interval } } }] },
  };
  subscriptions.push(sub);
  if (status === "past_due") cus.delinquent = true;
  const qty = sub.items.data[0]!.quantity;
  const months = Math.min(6, Math.floor((NOW - created) / (30 * DAY)) + 1);
  for (let m = months - 1; m >= 0; m--) {
    const n = invoices.length + 1;
    const ts = NOW - m * 30 * DAY - int(0, 3) * DAY;
    const amount = plan.amount * qty;
    const failed = status === "past_due" && m === 0;
    const open = status === "trialing" && m === 0;
    const inv = {
      id: idOf("in", n), object: "invoice", customer: cus.id, customer_name: company, subscription: sub.id, number: `ACME-${(1000 + n).toString()}`,
      created: ts, currency: "eur", amount_due: amount, amount_paid: failed || open ? 0 : amount, amount_remaining: failed || open ? amount : 0,
      status: failed ? "open" : open ? "draft" : "paid", attempt_count: failed ? int(2, 4) : 1, livemode: false,
      lines: { object: "list", data: [{ description: `${qty} × ${plan.nickname}`, amount, currency: "eur" }] },
    };
    invoices.push(inv);
    if (!open) {
      charges.push({
        id: idOf("ch", n), object: "charge", customer: cus.id, invoice: inv.id, amount, currency: "eur", created: ts + 600, livemode: false,
        paid: !failed, status: failed ? "failed" : "succeeded", refunded: !failed && rnd() < 0.04,
        failure_code: failed ? pick(["card_declined", "insufficient_funds", "expired_card"]) : null,
        payment_method_details: { type: "card", card: { brand: pick(["visa", "mastercard", "amex"]), last4: "4242" } },
        description: `Invoice ${inv.number}`,
      });
    }
  }
}

// ───────── HubSpot-like CRM ─────────
const STAGES = ["appointmentscheduled", "qualifiedtobuy", "presentationscheduled", "decisionmakerboughtin", "contractsent", "closedwon", "closedlost"] as const;
export const contacts = customers.slice(0, 24).map((c, i) => {
  const [first, last] = c.email.split("@")[0]!.split(".");
  return {
    id: String(5100 + i), properties: {
      firstname: first![0]!.toUpperCase() + first!.slice(1), lastname: last![0]!.toUpperCase() + last!.slice(1), email: c.email, company: c.name,
      lifecyclestage: pick(["customer", "customer", "opportunity", "lead"]), jobtitle: pick(["COO", "Head of Ops", "CTO", "Finance lead", "Office manager", "Founder"]),
      hs_lead_status: pick(["OPEN", "IN_PROGRESS", "CONNECTED", "ATTEMPTED_TO_CONTACT"]), createdate: new Date(c.created * 1000).toISOString(),
      stripe_customer_id: c.id,
    }, archived: false,
  };
});
for (let i = 0; i < 8; i++) {
  const first = pick(FIRST), last = pick(LAST), company = `${pick(ORG_A)} ${pick(ORG_B)}`;
  contacts.push({ id: String(5200 + i), properties: { firstname: first, lastname: last, email: `${first}.${last}@${company.toLowerCase().replace(/\s+/g, "")}.example`.toLowerCase(), company, lifecyclestage: "lead", jobtitle: pick(["CEO", "Head of Ops", "IT manager"]), hs_lead_status: "NEW", createdate: new Date((NOW - int(1, 20) * DAY) * 1000).toISOString(), stripe_customer_id: "" }, archived: false });
}
export const deals = contacts.filter(() => rnd() < 0.7).map((c, i) => {
  const stage = c.properties.lifecyclestage === "customer" ? pick(["closedwon", "closedwon", "contractsent"] as const) : pick(STAGES);
  return {
    id: String(9300 + i), properties: {
      dealname: `${c.properties.company} – ${pick(["Team plan", "Scale upgrade", "Annual renewal", "Pilot", "Seat expansion"])}`,
      dealstage: stage, pipeline: "default", amount: String(pick([2400, 4800, 9600, 19900, 24000, 48000, 107880])),
      closedate: new Date((NOW + (stage.startsWith("closed") ? -int(1, 60) : int(5, 75)) * DAY) * 1000).toISOString().slice(0, 10),
      hubspot_owner_id: pick(["owner_sales_1", "owner_sales_2"]), contact_id: c.id,
    }, archived: false,
  };
});

// ───────── Slack ─────────
export const channels = [
  { id: "C04ACMESUPP", name: "support", topic: { value: "Customer issues. Tag @support-lead for P1." }, num_members: 9 },
  { id: "C04ACMESALE", name: "sales", topic: { value: "Pipeline, renewals, wins" }, num_members: 6 },
  { id: "C04ACMEFINA", name: "finance", topic: { value: "Invoices, dunning, monthly close" }, num_members: 4 },
  { id: "C04ACMEGENR", name: "general", topic: { value: "Company-wide" }, num_members: 23 },
];
const users = ["U04AVAFAIR", "U04NOAHOKA", "U04MIALIND", "U04KAITANA", "U04LENABRA"];
/** Display names of the fictional Slack users (same people as the Drive owners). Used by the MCP resources. */
export const userNames: Record<string, string> = { U04AVAFAIR: "Ava Fairbank", U04NOAHOKA: "Noah Okafor", U04MIALIND: "Mia Lindqvist", U04KAITANA: "Kai Tanaka", U04LENABRA: "Lena Brandt" };
const cust = (i: number) => customers[i % customers.length]!.name;
const pastDue = subscriptions.filter((s) => s.status === "past_due").map((s) => customers.find((c) => c.id === s.customer)!.name);
const SCRIPT: Record<string, string[]> = {
  support: [
    `${cust(3)} reports CSV export times out for files over 50k rows. Ticket #4411.`,
    `Repro'd #4411 on staging. Export worker hits the 30 s limit. Workaround: filter by month.`,
    `${cust(7)} asks whether SSO (SAML) is in the Team plan or only Scale.`,
    `Answer for ${cust(7)}: SAML is Scale only; Team has Google sign-in. Sent the comparison doc.`,
    `P1: ${cust(11)} cannot log in after password reset – reset link expired immediately. Ticket #4420.`,
    `#4420 root cause: link TTL was set to 0 in last night's config change. Fixed 09:12, customer confirmed.`,
    `${cust(2)} wants an invoice re-issued with their new VAT number.`,
    `Third request this week about bulk user import. Should this go on the roadmap?`,
    `${cust(14)} says the mobile app logs them out every few hours. Ticket #4431.`,
    `Weekly: 41 tickets opened, 38 closed, median first reply 1h 50m.`,
  ],
  sales: [
    `${cust(5)} signed the annual Team renewal – €19.9k. 🎉`,
    `${cust(9)} pilot ends Friday. Champion is positive, procurement wants a security questionnaire.`,
    `Lost ${cust(16)} to a cheaper competitor; price was the only stated reason.`,
    `${cust(1)} wants 12 more seats from next month. Upgrade to Scale makes sense above 25 seats.`,
    `Q4 pipeline at €310k weighted. Need two more Scale deals to hit target.`,
    `Product walkthrough with ${cust(20)} on Tuesday – they use the CSV export heavily (see #4411).`,
  ],
  finance: [
    `Dunning run: ${pastDue.length} subscriptions past due: ${pastDue.join(", ") || "none"}.`,
    `October close: MRR up 4.1% m/m, churned MRR €1.2k.`,
    `${cust(2)} VAT number change – credit note + re-issue needed before month end.`,
    `Reminder: card expiry wave in November, ~6 customers on cards expiring 11/26.`,
    `Refund approved for duplicate charge on ${cust(18)}.`,
  ],
  general: [
    `Welcome to the team, Lena (Support)!`,
    `Office closed on Friday for the offsite. Support rota is in the Drive doc "Support rota Q4".`,
    `All-hands notes are in Drive: "All-hands 2026-10".`,
    `Reminder: security training due by 31 Oct.`,
  ],
};
export const messages: Record<string, { type: "message"; user: string; text: string; ts: string; channel: string; reply_count?: number }[]> = {};
for (const ch of channels) {
  const lines = SCRIPT[ch.name] ?? [];
  const drawn = lines.map((text, i) => ({
    type: "message" as const, user: pick(users), text, channel: ch.id,
    ts: `${NOW - (lines.length - i) * int(3, 9) * 3600}.${String(int(100000, 999999))}`,
    ...(rnd() < 0.3 ? { reply_count: int(1, 5) } : {}),
  }));
  // The drawn times are not in script order; hand them out ascending so each channel reads as one conversation (same draws as before).
  const times = drawn.map((m) => m.ts).sort();
  messages[ch.id] = drawn.map((m, i) => ({ ...m, ts: times[i]! })).reverse(); // Slack returns newest first
}

// ───────── Google Drive ─────────
const doc = (id: string, folder: string, name: string, mime: string, days: number, owner: string, body: string) => ({
  id, kind: "drive#file", name, folder, mimeType: mime, modifiedTime: new Date((NOW - days * DAY) * 1000).toISOString(),
  owners: [{ displayName: owner }], webViewLink: `https://drive.acme-llc.example/file/d/${id}`, body,
});
export const files = [
  doc("1hP4rQ7vXk2LmN8sT0wYbC3d", "Acme LLC/Sales", "Pricing and plans 2026", "application/vnd.google-apps.document", 12, "Ava Fairbank",
    "Starter €49/month (up to 3 seats, email support). Team €199/month or €1,990/year (up to 25 seats, Google sign-in, priority support). Scale €899/month (unlimited seats, SAML SSO, audit log, 99.9% SLA, named CSM). Discounts above 15% need the COO's approval. Annual prepay gets two months free."),
  doc("1rF9tK2pWq6ZsV1nB7xHjD4e", "Acme LLC/Finance", "Refund and credit policy", "application/vnd.google-apps.document", 40, "Noah Okafor",
    "Refunds within 14 days of a charge, no questions. Duplicate charges are refunded at once by Finance. After 14 days we issue account credit, not cash. Any refund above €2,000 needs the CFO's approval. VAT changes: issue a credit note and re-issue the invoice in the same month."),
  doc("1sR3oT8aY5uMkL2cQ9vNfG6h", "Acme LLC/Support", "Support rota Q4", "application/vnd.google-apps.spreadsheet", 5, "Lena Brandt",
    "Mon–Tue: Mia. Wed: Kai. Thu–Fri: Lena. P1 escalation: on-call engineer via #support with @support-lead. First reply target: 2 h in business hours, P1 30 min."),
  doc("1aH7nD4sK1pXrW9tB3mZqJ8c", "Acme LLC/Company", "All-hands 2026-10", "application/vnd.google-apps.document", 3, "Ava Fairbank",
    "Q3 revenue +18% y/y. Focus Q4: reduce churn in SMB (export performance, mobile sessions), land 2 more Scale customers, ship bulk user import. Hiring: 1 support engineer, 1 AE."),
  doc("1bE2xP6rT9nCvK4mS7wQaL1f", "Acme LLC/Support/Runbooks", "Runbook – CSV export timeouts", "application/vnd.google-apps.document", 2, "Kai Tanaka",
    "Symptom: exports over ~50k rows fail after 30 s. Cause: synchronous export worker. Workaround: filter by month or use the API with pagination. Fix planned: async export with email link (ENG-212)."),
  doc("1sQ8cU3rY6tBnH1kM5pVxW2g", "Acme LLC/Security", "Security questionnaire – standard answers", "application/vnd.google-apps.document", 25, "Omar Haddad",
    "Data hosted in the EU (Frankfurt). Encryption at rest AES-256, in transit TLS 1.2+. SOC 2 Type I done, Type II in progress (expected Q1). SAML SSO on Scale. Pen test yearly, last in June."),
  doc("1oN5bR8dF2gTkJ7wL4sCyZ9m", "Acme LLC/Customer Success", "Customer onboarding checklist", "application/vnd.google-apps.document", 60, "Mia Lindqvist",
    "Kick-off call within 3 days of signature. Import users (CSV today; bulk import planned). Configure sign-in. Training session. 30-day check-in by the CSM."),
];

export function stripeList<T extends { created?: number }>(rows: T[], q: URLSearchParams, url: string, filter?: (r: T) => boolean) {
  const limit = Math.min(100, Math.max(1, Number(q.get("limit") ?? 10)));
  let data = filter ? rows.filter(filter) : rows.slice();
  const after = q.get("starting_after");
  if (after) data = data.slice(data.findIndex((r) => (r as unknown as { id: string }).id === after) + 1);
  return { object: "list", url, has_more: data.length > limit, data: data.slice(0, limit) };
}
