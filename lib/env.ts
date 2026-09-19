import { env } from "cloudflare:workers";

type RuntimeEnv = {
  ADMIN_PASSWORD?: string;
  SESSION_SECRET?: string;
  WORKER_TOKEN?: string;
};

export function runtimeEnv(): RuntimeEnv {
  return env as RuntimeEnv;
}

export function requiredEnv(key: keyof RuntimeEnv): string {
  const value = runtimeEnv()[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}
