import { createRequest, listRequests } from "@/lib/db";
import { json, requireAdmin, sanitizeText } from "@/lib/http";

export const dynamic = "force-dynamic";

const TYPES = new Set(["mac_status", "file_cleanup", "development", "custom"]);

function classify(type: string, body: string) {
  const riskyWords = [
    "삭제",
    "지워",
    "kill",
    "종료",
    "uninstall",
    "remove",
    "rm ",
    "launchctl",
    "자동시작",
  ];
  const risky = type === "file_cleanup" || riskyWords.some((word) => body.includes(word));
  return {
    risk: risky ? "approval_required" : "safe",
    status: risky ? "approval_required" : "queued",
  };
}

export async function GET() {
  const denied = await requireAdmin();
  if (denied) return denied;
  return json({ requests: await listRequests() });
}

export async function POST(request: Request) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const payload = (await request.json().catch(() => ({}))) as {
    type?: string;
    title?: string;
    body?: string;
  };
  const type = TYPES.has(String(payload.type)) ? String(payload.type) : "custom";
  const title = sanitizeText(payload.title, "Untitled request").slice(0, 140);
  const body = sanitizeText(payload.body);
  if (!title || !body) {
    return json({ error: "missing_title_or_body" }, { status: 400 });
  }

  const classification = classify(type, body);
  const item = await createRequest({ type, title, body, ...classification });
  return json({ request: item }, { status: 201 });
}
