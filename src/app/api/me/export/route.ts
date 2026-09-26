import { getDb } from "@/server/db/client";
import { AppError } from "@/server/lib/errors";
import { exportMyData } from "@/server/services/export";
import { getViewer } from "@/server/web/session";

export const dynamic = "force-dynamic";

/**
 * 本人のデータを JSON でダウンロードさせる。フォームの POST だけを受ける
 * （他サイトからの POST には SameSite=Lax のセッション Cookie が付かないので、本人の操作に限られる）。
 */
export async function POST() {
  const headers = { "Cache-Control": "no-store" };
  try {
    const data = await exportMyData(await getDb(), (await getViewer())!);
    // ファイル名の日付は日本時間（sv-SE は YYYY-MM-DD で出る）
    const date = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date()).replaceAll("-", "");
    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        ...headers,
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="kakomi-export-${date}.json"`,
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (e) {
    if (e instanceof AppError) {
      const status = e.code === "rate_limited" ? 429 : e.code === "unauthorized" ? 401 : 403;
      return new Response(e.message, { status, headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" } });
    }
    throw e;
  }
}
