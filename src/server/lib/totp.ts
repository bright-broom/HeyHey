import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * TOTP（RFC 6238）。Google Authenticator・1Password・Authy などの認証アプリと互換の既定値
 * （HMAC-SHA1・6 桁・30 秒）に固定する。外部ライブラリに頼らず node:crypto だけで実装する。
 * このファイルは E2E テストからも読むので、server-only を付けない。
 */
export const TOTP_PERIOD_SEC = 30;
export const TOTP_DIGITS = 6;
/** 端末の時計ずれを前後 1 ステップ（±30 秒）まで許す */
const DRIFT_STEPS = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error("invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160 bit の秘密鍵（RFC 4226 の推奨長）を Base32 で返す */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export const totpStep = (nowMs: number) => Math.floor(nowMs / 1000 / TOTP_PERIOD_SEC);

/** 指定ステップのコード。digits はテストベクタ（8 桁）の検証用 */
export function totpCode(secretB32: string, step: number, digits = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const bin = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return bin.toString().padStart(digits, "0");
}

/**
 * 入力されたコードを検証し、一致したステップを返す。
 * afterStep 以下のステップは受け付けない（同じコードの使い回し＝リプレイを防ぐ）。
 */
export function verifyTotp(secretB32: string, input: string, opts: { now?: number; afterStep?: number | null } = {}): number | null {
  const code = input.replace(/\s/g, "");
  if (!/^\d{6}$/.test(code)) return null;
  const current = totpStep(opts.now ?? Date.now());
  let matched: number | null = null;
  // 早期 return せず全候補を比べ、どのステップで一致したかを処理時間から推測させない
  for (let step = current - DRIFT_STEPS; step <= current + DRIFT_STEPS; step++) {
    const ok = timingSafeEqual(Buffer.from(totpCode(secretB32, step)), Buffer.from(code));
    if (ok && matched === null && (opts.afterStep == null || step > opts.afterStep)) matched = step;
  }
  return matched;
}

/** 認証アプリに読み込ませる otpauth URI（QR コードの中身） */
export function otpauthUri(secretB32: string, account: string, issuer = "Kakomi"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret: secretB32, issuer, algorithm: "SHA1", digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SEC) });
  return `otpauth://totp/${label}?${params.toString()}`;
}
