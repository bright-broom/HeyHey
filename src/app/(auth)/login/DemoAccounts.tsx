import { demoLoginAction } from "@/app/actions/auth";
import { DEMO_ACCOUNTS, DEMO_GROUP_LABELS, DEMO_PASSWORD, type DemoGroup } from "@/server/lib/demo";

/**
 * ローカル開発専用のデモアカウント一覧。権限・状態ごとに 1 クリックで入れる。
 * 呼び出し側（ログイン画面）で demoLoginEnabled() を確かめてから描画し、Server Action 側でも再確認する。
 */
export function DemoAccounts() {
  const groups = Object.keys(DEMO_GROUP_LABELS) as DemoGroup[];
  return (
    <section aria-labelledby="demo-title" className="space-y-8">
      <div>
        <p className="plaque">DEMO · LOCAL ONLY</p>
        <h2 id="demo-title" className="h2 mt-2">デモアカウント</h2>
        <p className="hint">
          ローカル開発専用です。パスワードと 2 段階認証を省いて入ります（本番には表示されず、使えません）。
          <br />
          パスワードで入るときは、すべて <code className="font-mono">{DEMO_PASSWORD}</code>。
        </p>
      </div>
      {groups.map((g) => (
        <div key={g} className="space-y-2">
          <h3 className="plaque text-ink-soft">{DEMO_GROUP_LABELS[g]}</h3>
          <ul className="divide-y divide-line border-y border-line">
            {DEMO_ACCOUNTS.filter((a) => a.group === g).map((a) => (
              <li key={a.email}>
                <form action={demoLoginAction} className="flex items-center gap-4 py-3">
                  <input type="hidden" name="email" value={a.email} />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      {a.name}
                      <span className="ml-2 text-xs text-muted">{a.label}</span>
                    </p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">{a.tryThis}</p>
                  </div>
                  <button type="submit" className="btn-ghost shrink-0 px-3 py-1.5 text-xs" aria-label={`${a.name}（${a.label}）で入る`} data-testid="demo-login" data-email={a.email}>
                    入る
                  </button>
                </form>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
}
