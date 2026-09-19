import { cookies } from "next/headers";
import { requiredEnv, runtimeEnv } from "./env";

const COOKIE_NAME = "hermes_ops_session";
const MAX_AGE_SECONDS = 60 * 60 * 12;

function bytesToHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function hmac(message: string) {
  const secret = requiredEnv("SESSION_SECRET");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return bytesToHex(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
  );
}

export async function verifyPassword(password: string) {
  return password === requiredEnv("ADMIN_PASSWORD");
}

export async function createSessionCookie() {
  const issuedAt = Date.now();
  const payload = `admin.${issuedAt}`;
  const signature = await hmac(payload);
  return `${payload}.${signature}`;
}

export async function isAdminSession() {
  const jar = await cookies();
  const value = jar.get(COOKIE_NAME)?.value;
  if (!value) return false;

  const parts = value.split(".");
  if (parts.length !== 3) return false;
  const [subject, issuedAtText, signature] = parts;
  if (subject !== "admin") return false;
  const issuedAt = Number(issuedAtText);
  if (!Number.isFinite(issuedAt)) return false;
  if (Date.now() - issuedAt > MAX_AGE_SECONDS * 1000) return false;

  return (await hmac(`${subject}.${issuedAtText}`)) === signature;
}

export async function setSessionCookie(response: Response) {
  const value = await createSessionCookie();
  response.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=${value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${MAX_AGE_SECONDS}`,
  );
}

export function clearSessionCookie(response: Response) {
  response.headers.append(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
  );
}

export function verifyWorkerAuth(request: Request) {
  const expected = runtimeEnv().WORKER_TOKEN;
  if (!expected) throw new Error("Missing required environment variable: WORKER_TOKEN");
  const value = request.headers.get("authorization") ?? "";
  const workerToken = request.headers.get("x-worker-token") ?? "";
  return value === `Bearer ${expected}` || workerToken === expected;
}
