import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * DB に置く秘密（2 段階認証の鍵）の暗号化。AES-256-GCM。
 * 鍵は環境変数 MFA_ENCRYPTION_KEY（32 バイトを Base64 化したもの）で、DB とは別の場所に置く。
 * DB のダンプやバックアップだけが漏れても、2 段階認証を突破できないようにするため。
 *
 * 形式：v1.<iv>.<tag>.<暗号文>（各 base64url）。
 * aad（会員 ID）を付けて暗号化するので、別の会員の行へ暗号文を移し替えても復号できない。
 */
const VERSION = "v1";
const DEV_KEY = createHash("sha256").update("kakomi-dev-only-mfa-key").digest();

export class MissingKeyError extends Error {
  constructor() {
    super("MFA_ENCRYPTION_KEY が設定されていません（本番では必須）");
    this.name = "MissingKeyError";
  }
}

function key(): Buffer {
  const raw = process.env.MFA_ENCRYPTION_KEY;
  if (raw) {
    const k = Buffer.from(raw, "base64");
    if (k.length !== 32) throw new Error("MFA_ENCRYPTION_KEY は 32 バイトを Base64 化した値にしてください（openssl rand -base64 32）");
    return k;
  }
  // 本番（Vercel、または実際の PostgreSQL につないでいる環境）で鍵を置き忘れたまま、
  // 誰でも知っている開発用の鍵で暗号化してしまうことを防ぐ。開発用の鍵はローカルの PGlite 専用
  if (process.env.VERCEL || process.env.DATABASE_URL) throw new MissingKeyError();
  return DEV_KEY;
}

export function seal(plain: string, aad: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return [VERSION, iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function open(sealed: string, aad: string): string {
  const [v, iv, tag, ct] = sealed.split(".");
  if (v !== VERSION || !iv || !tag || !ct) throw new Error("unsupported sealed format");
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
