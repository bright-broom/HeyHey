import "server-only";
import { AppError } from "../lib/errors";

export type FormState = { error?: string; ok?: string; fields?: Record<string, string> } | undefined;

/** 業務エラーは画面に出すメッセージとして返し、それ以外（バグ）はそのまま投げる */
export async function attempt(fn: () => Promise<string | void>): Promise<FormState> {
  try {
    const ok = await fn();
    return { ok: ok ?? undefined };
  } catch (e) {
    if (e instanceof AppError) return { error: e.message };
    throw e;
  }
}

export function str(fd: FormData, key: string): string {
  const v = fd.get(key);
  return typeof v === "string" ? v : "";
}

export async function files(fd: FormData, key: string): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const v of fd.getAll(key)) {
    if (typeof v !== "string" && v.size > 0) out.push(Buffer.from(await v.arrayBuffer()));
  }
  return out;
}
