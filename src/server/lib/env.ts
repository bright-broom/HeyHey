/**
 * 公開 URL。APP_URL を優先し、Vercel では本番ドメイン（システム環境変数）を自動で使う。
 */
export function appBaseUrl(): string {
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  return "http://localhost:3000";
}

/** https で公開されているか（Vercel は常に https） */
export function isHttps(): boolean {
  return !!process.env.VERCEL || appBaseUrl().startsWith("https://");
}
