import { getDb } from "@/server/db/client";
import { AppError } from "@/server/lib/errors";
import { unsubscribe } from "@/server/services/email-notify";

export const dynamic = "force-dynamic";

/**
 * メールソフトの「配信停止」ボタン（RFC 8058 のワンクリック配信停止）。
 * メールソフトは List-Unsubscribe-Post に従って POST してくる。GET では何もしない（リンク検査ボット対策）。
 */
export async function POST(_req: Request, ctx: RouteContext<"/api/unsubscribe/[token]">) {
  const { token } = await ctx.params;
  try {
    await unsubscribe(await getDb(), token);
    return new Response("unsubscribed", { status: 200, headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    if (e instanceof AppError) return new Response("invalid", { status: 400, headers: { "Cache-Control": "no-store" } });
    throw e;
  }
}
