import { verifyWorkerAuth } from "@/lib/auth";
import { finishRequest } from "@/lib/db";
import { json, sanitizeText } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!verifyWorkerAuth(request)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  const payload = (await request.json().catch(() => ({}))) as {
    id?: string;
    status?: "done" | "failed";
    result?: string;
    workerLog?: string;
  };
  if (!payload.id || !["done", "failed"].includes(String(payload.status))) {
    return json({ error: "invalid_result" }, { status: 400 });
  }
  await finishRequest({
    id: payload.id,
    status: payload.status as "done" | "failed",
    result: sanitizeText(payload.result),
    workerLog: sanitizeText(payload.workerLog),
  });
  return json({ ok: true });
}
