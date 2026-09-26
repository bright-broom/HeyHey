import { createHash, timingSafeEqual } from "node:crypto";
import { getDb } from "@/server/db/client";
import { runDailyMaintenance } from "@/server/services/maintenance";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/**
 * 毎日の定期処理（vercel.json の crons から呼ばれる）。
 * Vercel Cron は CRON_SECRET を Authorization: Bearer で送ってくる。
 * CRON_SECRET が未設定なら誰にも実行させない（公開 URL なので、設定漏れで開けっぱなしにしない）。
 */
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  // ハッシュ同士を比べる（長さも中身も、比較の時間から推測させない）
  const digest = (v: string) => createHash("sha256").update(v).digest();
  const ok = !!secret && timingSafeEqual(digest(req.headers.get("authorization") ?? ""), digest(`Bearer ${secret}`));
  if (!ok) return new Response("Not Found", { status: 404 });
  const report = await runDailyMaintenance(await getDb());
  return Response.json(report, { headers: { "Cache-Control": "no-store" } });
}
