/**
 * Delegated authority (../../../../DELEGATION.md), written from the contract alone: the author's
 * `authority/delegations.json` in the workspace is read here, judged here, and what was done under it
 * is appended to `authority/trucheman.jsonl`. No other tool is asked anything.
 */
import { appendFile, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

// The entry's fingerprint (DELEGATION.md §4): sha256 of its canonical JSON without `revoked_at`, so revoking is not
// editing but any other change to an entry already used shows against the journal.
const canonical = (v: unknown): string =>
  v === null || typeof v !== "object"
    ? JSON.stringify(v)
    : Array.isArray(v)
      ? `[${v.map(canonical).join(",")}]`
      : `{${Object.keys(v as object)
          .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
          .join(",")}}`;
export const delegationHash = (d: object): string =>
  `sha256:${createHash("sha256")
    .update(canonical({ ...d, revoked_at: undefined }), "utf8")
    .digest("hex")}`;

const WEEK = 7 * 24 * 3600 * 1000;
export const CURRENCY = "USD";

type Delegation = {
  id: string;
  workspace?: string;
  granted_by?: string;
  granted_at?: string;
  expires_at?: string;
  allow?: string[];
  deny?: string[];
  limits?: { max_spend?: number; currency?: string };
  revoked_at?: string | null;
};

async function workspaceInfo(root: string) {
  const config = (parseYaml(await readFile(join(root, "codicora.yaml"), "utf8")) ?? {}) as {
    project?: { id?: string };
    authority?: { path?: string };
  };
  return { id: config.project?.id, dir: resolve(root, config.authority?.path ?? "./authority") };
}

function invalid(d: Delegation, ws: string | undefined, now: number): string | null {
  const granted = Date.parse(d.granted_at ?? ""),
    expires = Date.parse(d.expires_at ?? "");
  if (
    !d.workspace ||
    !d.granted_by ||
    !Array.isArray(d.allow) ||
    Number.isNaN(granted) ||
    Number.isNaN(expires)
  )
    return "is missing workspace, granted_by, granted_at, expires_at or allow";
  if (d.workspace !== ws) return `belongs to workspace "${d.workspace}", not "${ws}"`;
  if (expires - granted > WEEK) return "is longer than 7 days and is not valid";
  if (now < granted) return `is not valid before ${d.granted_at}`;
  if (now >= expires) return `expired at ${d.expires_at}`;
  if (d.revoked_at && Date.parse(d.revoked_at) <= now) return `was revoked at ${d.revoked_at}`;
  return null;
}

/**
 * Spent under `id`, all tools together, in `currency` (DELEGATION.md §4): settled reservations at their actual cost,
 * open ones at their whole amount (the work may have been billed and nobody wrote down what it cost), and the `cost`
 * of action lines written before reservations existed.
 */
export async function spentUnder(dir: string, id: string, currency: string) {
  const lines: Record<string, unknown>[] = [];
  for (const name of (await readdir(dir).catch(() => [] as string[])).filter((n) =>
    n.endsWith(".jsonl"),
  )) {
    for (const [n, line] of (await readFile(join(dir, name), "utf8")).split("\n").entries()) {
      if (!line.trim()) continue;
      let r: unknown;
      try {
        r = JSON.parse(line);
      } catch {
        r = null;
      }
      // A torn or corrupt record may be a reservation: counting around it would under-count what is held,
      // so no new spending until someone repairs the journal (the line stays as evidence).
      if (!r || typeof r !== "object")
        throw new Error(
          `authority/${name} line ${n + 1} is not a JSON record (torn or corrupt); no paid call is authorized until it is repaired`,
        );
      lines.push(r as Record<string, unknown>);
    }
  }
  const settled = new Map(
    lines
      .filter((r) => r.event === "settle" && typeof r.cost === "number")
      .map((r) => [r.reservation_id, r.cost as number]),
  );
  let total = 0;
  for (const r of lines) {
    if (r.delegation_id !== id || r.currency !== currency) continue;
    if (r.event === "reserve" && typeof r.amount === "number")
      total += settled.get(r.reservation_id) ?? r.amount;
    else if (r.event === undefined && typeof r.cost === "number") total += r.cost;
  }
  return total;
}

// authority/.budget.lock is held only while a reservation is checked and written, never while a job runs.
// ponytail: a lock older than 30 s is a crashed holder and is broken; two waiters breaking the same stale lock
// at once could both proceed — that needs a crash and a race together.
async function withBudgetLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(dir, { recursive: true });
  const lock = join(dir, ".budget.lock");
  for (const started = Date.now(); ; ) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age =
        Date.now() -
        (await stat(lock).then(
          (s) => s.mtimeMs,
          () => Date.now(),
        ));
      if (age > 30_000) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - started > 10_000)
        throw new Error("The budget lock authority/.budget.lock stayed held for 10 s; try again.");
      await new Promise((r) => setTimeout(r, 5 + Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

/** Why delegation `id` does not cover `capability` in the workspace at `root` at `now`; null when it does. */
export async function delegationProblem(
  root: string,
  id: string,
  capability: string,
  now = Date.now(),
): Promise<string | null> {
  try {
    await authorize(root, id, capability, 0, now);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
}

export type Granted = { delegation: Delegation; dir: string; spent: number };

/**
 * The delegation covers `capability` and, when `estimate` is given, a spend of that much in USD
 * on top of what was already spent under it. Throws a message for the author otherwise.
 */
export async function authorize(
  root: string,
  id: string,
  capability: string,
  estimate: number | null,
  now = Date.now(),
): Promise<Granted> {
  const { id: ws, dir } = await workspaceInfo(root);
  let doc: { schema?: string; delegations?: Delegation[] } | null = null;
  try {
    doc = JSON.parse(await readFile(join(dir, "delegations.json"), "utf8"));
  } catch {
    /* no file: nothing delegated */
  }
  if (doc?.schema !== "codicora.delegations/0.1")
    throw new Error("No readable authority/delegations.json — the author has delegated nothing.");
  const d = (doc.delegations ?? []).find((x) => x?.id === id);
  if (!d) throw new Error(`No delegation "${id}" in authority/delegations.json.`);
  const why =
    invalid(d, ws, now) ??
    (d.deny?.includes(capability)
      ? `denies ${capability}`
      : !d.allow!.includes(capability)
        ? `does not allow ${capability}`
        : null);
  if (why) throw new Error(`Delegation "${id}" ${why}. Stop and ask the author.`);
  const spent = await spentUnder(dir, id, CURRENCY);
  if (estimate === 0) return { delegation: d, dir, spent };
  if (estimate === null)
    throw new Error(
      "Trucheman cannot bound the cost of this run (set TRUCHEMAN_MAX_USD_PER_MILLION_CHARS to a worst-case price), so a delegation cannot cover it; the author must confirm directly.",
    );
  const { max_spend: max, currency } = d.limits ?? {};
  if (typeof max !== "number")
    throw new Error(
      `Delegation "${id}" sets no spending limit, so it covers no paid run; ask the author.`,
    );
  if (currency !== CURRENCY)
    throw new Error(
      `Trucheman prices in ${CURRENCY} and delegation "${id}" limits spending in ${currency}; no conversion is applied — ask the author.`,
    );
  if (spent + estimate > max)
    throw new Error(
      `Over the delegated budget: ${spent.toFixed(2)} spent + ${estimate.toFixed(2)} worst case > ${max} ${CURRENCY}. Ask the author for ${(spent + estimate - max).toFixed(2)} ${CURRENCY} more (a new delegation) or to confirm directly.`,
    );
  return { delegation: d, dir, spent };
}

/**
 * Book `amount` against the delegation before the work it pays for is dispatched: under the budget lock the
 * delegation is read again and every tool's spending and open reservations are added up, so two jobs cannot
 * together reserve past the limit. Trucheman knows tokens, not prices, so the worst case is never settled to a
 * lower actual cost — only to zero when nothing was dispatched.
 */
export async function reserve(
  root: string,
  id: string,
  capability: string,
  amount: number | null,
  record: Record<string, unknown>,
): Promise<{ granted: Granted; reservation_id: string }> {
  const first = await authorize(root, id, capability, 0);
  return withBudgetLock(first.dir, async () => {
    const granted = await authorize(root, id, capability, amount);
    const reservation_id = `trucheman:${randomUUID()}`;
    await journal(granted, { event: "reserve", reservation_id, capability, ...record, amount, currency: CURRENCY });
    return { granted, reservation_id };
  });
}

export async function release(g: Granted, reservation_id: string) {
  await journal(g, { event: "settle", reservation_id, cost: 0, currency: CURRENCY, note: "nothing was dispatched" });
}

export async function journal(g: Granted, record: Record<string, unknown>) {
  await mkdir(g.dir, { recursive: true });
  await appendFile(
    join(g.dir, "trucheman.jsonl"),
    `${JSON.stringify({ schema: "codicora.action/0.1", at: new Date().toISOString(), tool: "trucheman", authority: "delegated", authorized_by: g.delegation.granted_by, delegation_id: g.delegation.id, delegation_hash: delegationHash(g.delegation), ...record })}\n`,
  );
}

/**
 * Worst-case cost of translating `chars` source characters through the whole pipeline.
 * ponytail: one operator-set price per million source characters (all stages, retries included),
 * because Trucheman records tokens but has no price table; per-model prices if this proves too coarse.
 */
export function estimateUsd(chars: number, env: NodeJS.ProcessEnv = process.env): number | null {
  const price = Number(env.TRUCHEMAN_MAX_USD_PER_MILLION_CHARS);
  return Number.isFinite(price) && price > 0 ? Math.ceil((chars / 1e6) * price * 100) / 100 : null;
}
