import Link from "next/link";
import { PageTitle } from "@/components/PageTitle";
import { formatDateTime } from "@/components/time";
import { getDb } from "@/server/db/client";
import { hasAdminRole } from "@/server/lib/policy";
import { getMfaState } from "@/server/services/mfa";
import { requireMember } from "@/server/web/session";
import { SecurityPanel } from "./SecurityPanel";

export const metadata = { title: "2 段階認証" };

export default async function SecurityPage(props: PageProps<"/settings/security">) {
  const viewer = await requireMember();
  const state = await getMfaState(await getDb(), viewer);
  const required = hasAdminRole(viewer) && !state.enabled;
  const sp = await props.searchParams;
  return (
    <div className="max-w-3xl">
      <PageTitle
        plaque="SECURITY"
        title="2 段階認証"
        lead="ログインのときに、パスワードに加えて認証アプリの 6 桁のコードを求めます。パスワードが漏れても、スマートフォンがなければ入れません。"
      >
        <Link href="/settings" className="btn-link">
          設定に戻る
        </Link>
      </PageTitle>
      {required && (
        <p role={sp.required ? "alert" : undefined} className="mb-10 border-l-2 border-ink py-1 pl-3 text-sm">
          管理者は 2 段階認証が必須です。設定が終わるまで、管理機能は使えません。
          設定には、運営者が発行する設定チケットが必要です。
        </p>
      )}
      <SecurityPanel
        enabled={state.enabled}
        enabledAtLabel={formatDateTime(state.enabledAt)}
        recoveryRemaining={state.recoveryRemaining}
        needsTicket={hasAdminRole(viewer)}
        canDisable={!hasAdminRole(viewer)}
        adminAfter={hasAdminRole(viewer)}
      />
    </div>
  );
}
