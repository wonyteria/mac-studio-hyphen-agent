import { setSessionCookie, verifyPassword } from "@/lib/auth";
import { json, sanitizeText } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { password?: string };
  const password = sanitizeText(body.password);
  if (!(await verifyPassword(password))) {
    return json({ error: "invalid_password" }, { status: 401 });
  }

  const response = json({ ok: true });
  await setSessionCookie(response);
  return response;
}
