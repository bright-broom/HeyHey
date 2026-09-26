/**
 * 公開 URL。APP_URL を優先し、Vercel では本番ドメイン（システム環境変数）を自動で使う。
 */
export function appBaseUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return `http://localhost:${process.env.PORT ?? 3000}`;
}

/** https で公開されているか（Vercel は常に https） */
export function isHttps(): boolean {
  return !!process.env.VERCEL || appBaseUrl().startsWith("https://");
}

/**
 * 開発サーバー（next dev）では、`vercel env pull` で .env.local に入った本番の DB や Blob を使わない。
 * 手元の操作で本番のデータを書き換える事故を防ぐため、ローカルの PGlite とディスクに切り替える。
 * どうしてもつなぐときだけ ALLOW_REMOTE_IN_DEV=1 を付ける。
 */
const remoteAllowed = () => process.env.NODE_ENV !== "development" || process.env.ALLOW_REMOTE_IN_DEV === "1";

function isLocalDbUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
  } catch {
    return false;
  }
}

/** 実際につなぐ PostgreSQL の URL。undefined ならローカルの PGlite を使う */
export function databaseUrl(): string | undefined {
  const url = process.env.DATABASE_URL;
  if (!url) return undefined;
  return remoteAllowed() || isLocalDbUrl(url) ? url : undefined;
}

/** 画像を Vercel Blob に保存するか（false ならローカルディスク） */
export function blobEnabled(): boolean {
  return remoteAllowed() && !!(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);
}
