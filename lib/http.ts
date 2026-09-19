import { isAdminSession } from "./auth";

export function json(data: unknown, init?: ResponseInit) {
  return Response.json(data, {
    ...init,
    headers: {
      "Cache-Control": "no-store",
      ...(init?.headers ?? {}),
    },
  });
}

export async function requireAdmin() {
  if (!(await isAdminSession())) {
    return json({ error: "unauthorized" }, { status: 401 });
  }
  return null;
}

export function sanitizeText(value: unknown, fallback = "") {
  return String(value ?? fallback).trim().slice(0, 6000);
}
