import { verifyWorkerAuth } from "@/lib/auth";
import { claimNextRequest } from "@/lib/db";
import { json } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!verifyWorkerAuth(request)) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  return json({ request: await claimNextRequest() });
}
