import { clearSessionCookie } from "@/lib/auth";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST() {
  const response = json({ ok: true });
  clearSessionCookie(response);
  return response;
}
