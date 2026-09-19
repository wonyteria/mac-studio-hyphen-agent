import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type OpsRequest = {
  id: string;
  type: string;
  title: string;
  body: string;
  status: string;
  risk: string;
  result: string | null;
  worker_log: string | null;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  completed_at: number | null;
};

type Store = { requests: OpsRequest[] };

async function d1(): Promise<D1Database | null> {
  return null;
}

function dataFile() {
  return process.env.HERMES_DATA_FILE || "/tmp/hermes-mac-ops/requests.json";
}

async function readStore(): Promise<Store> {
  try {
    return JSON.parse(await readFile(dataFile(), "utf8")) as Store;
  } catch {
    return { requests: [] };
  }
}

async function writeStore(store: Store) {
  const target = dataFile();
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, JSON.stringify(store, null, 2), "utf8");
  await rename(temp, target);
}

export async function ensureSchema() {
  const db = await d1();
  if (!db) return;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS ops_requests (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        risk TEXT NOT NULL,
        result TEXT,
        worker_log TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        claimed_at INTEGER,
        completed_at INTEGER
      )`,
    )
    .run();
  await db
    .prepare(
      `CREATE INDEX IF NOT EXISTS idx_ops_requests_status_updated
       ON ops_requests(status, updated_at)`,
    )
    .run();
}

export async function listRequests(): Promise<OpsRequest[]> {
  await ensureSchema();
  const db = await d1();
  if (!db) {
    const store = await readStore();
    return store.requests.sort((a, b) => b.created_at - a.created_at).slice(0, 80);
  }
  const rows = await db
    .prepare(
      `SELECT * FROM ops_requests
       ORDER BY created_at DESC
       LIMIT 80`,
    )
    .all<OpsRequest>();
  return rows.results ?? [];
}

export async function createRequest(input: {
  type: string;
  title: string;
  body: string;
  risk: string;
  status: string;
}): Promise<OpsRequest> {
  await ensureSchema();
  const now = Date.now();
  const id = crypto.randomUUID();
  const db = await d1();
  if (!db) {
    const request: OpsRequest = {
      id,
      type: input.type,
      title: input.title,
      body: input.body,
      status: input.status,
      risk: input.risk,
      result: null,
      worker_log: null,
      created_at: now,
      updated_at: now,
      claimed_at: null,
      completed_at: null,
    };
    const store = await readStore();
    store.requests.push(request);
    await writeStore(store);
    return request;
  }
  await db
    .prepare(
      `INSERT INTO ops_requests
       (id, type, title, body, status, risk, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, input.type, input.title, input.body, input.status, input.risk, now, now)
    .run();
  const request = await getRequest(id);
  if (!request) throw new Error("Created request could not be loaded");
  return request;
}

export async function getRequest(id: string): Promise<OpsRequest | null> {
  await ensureSchema();
  const db = await d1();
  if (!db) {
    const store = await readStore();
    return store.requests.find((request) => request.id === id) ?? null;
  }
  const row = await db
    .prepare(`SELECT * FROM ops_requests WHERE id = ?`)
    .bind(id)
    .first<OpsRequest>();
  return row ?? null;
}

export async function approveRequest(id: string) {
  await ensureSchema();
  const db = await d1();
  if (!db) {
    const store = await readStore();
    const request = store.requests.find((item) => item.id === id && item.status === "approval_required");
    if (request) {
      request.status = "queued";
      request.updated_at = Date.now();
      await writeStore(store);
    }
    return;
  }
  await db
    .prepare(
      `UPDATE ops_requests
       SET status = 'queued', updated_at = ?
       WHERE id = ? AND status = 'approval_required'`,
    )
    .bind(Date.now(), id)
    .run();
}

export async function claimNextRequest(): Promise<OpsRequest | null> {
  await ensureSchema();
  const now = Date.now();
  const db = await d1();
  if (!db) {
    const store = await readStore();
    const next = store.requests
      .filter((request) => request.status === "queued")
      .sort((a, b) => a.created_at - b.created_at)[0];
    if (!next) return null;
    next.status = "running";
    next.claimed_at = now;
    next.updated_at = now;
    await writeStore(store);
    return next;
  }
  const next = await db
    .prepare(
      `SELECT * FROM ops_requests
       WHERE status = 'queued'
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .first<OpsRequest>();
  if (!next) return null;
  await db
    .prepare(
      `UPDATE ops_requests
       SET status = 'running', claimed_at = ?, updated_at = ?
       WHERE id = ? AND status = 'queued'`,
    )
    .bind(now, now, next.id)
    .run();
  return getRequest(next.id);
}

export async function finishRequest(input: {
  id: string;
  status: "done" | "failed";
  result: string;
  workerLog?: string;
}) {
  await ensureSchema();
  const now = Date.now();
  const db = await d1();
  if (!db) {
    const store = await readStore();
    const request = store.requests.find((item) => item.id === input.id);
    if (request) {
      request.status = input.status;
      request.result = input.result;
      request.worker_log = input.workerLog ?? "";
      request.completed_at = now;
      request.updated_at = now;
      await writeStore(store);
    }
    return;
  }
  await db
    .prepare(
      `UPDATE ops_requests
       SET status = ?, result = ?, worker_log = ?, completed_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(input.status, input.result, input.workerLog ?? "", now, now, input.id)
    .run();
}
