import { approveRequest, getRequest } from "@/lib/db";
import { json, requireAdmin } from "@/lib/http";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const denied = await requireAdmin();
  if (denied) return denied;

  const { id } = await context.params;
  await approveRequest(id);
  return json({ request: await getRequest(id) });
}
