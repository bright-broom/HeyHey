import { createHash, randomBytes } from "node:crypto";

/** URL・Cookie に載せる推測不能なトークン（256 bit） */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

/** DB にはトークンそのものではなくハッシュだけを保存する */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
