"use client";

import { useActionState, useState } from "react";
import { beginMfaAction, confirmMfaAction, disableMfaAction, regenerateRecoveryAction } from "@/app/actions/mfa";
import { FormMessage } from "@/components/FormMessage";
import { QrCode } from "@/components/QrCode";
import { SubmitButton } from "@/components/SubmitButton";

type Props = {
  enabled: boolean;
  enabledAtLabel: string;
  recoveryRemaining: number;
  needsTicket: boolean;
  canDisable: boolean;
  adminAfter: boolean;
};

/**
 * 設定の流れ：始める → QR を読み取る → パスワードとコードで確認 → リカバリーコードを控える。
 * 状態を 1 つのコンポーネントに持たせ、リカバリーコードの表示中に画面が差し替わらないようにする。
 */
export function SecurityPanel(p: Props) {
  const [begin, beginAction] = useActionState(beginMfaAction, undefined);
  const [confirm, confirmAction] = useActionState(confirmMfaAction, undefined);
  const [regen, regenAction] = useActionState(regenerateRecoveryAction, undefined);
  const [disable, disableAction] = useActionState(disableMfaAction, undefined);

  const codes = confirm?.recoveryCodes ?? regen?.recoveryCodes;
  if (codes) return <RecoveryCodes codes={codes} adminAfter={p.adminAfter && !!confirm?.recoveryCodes} />;

  if (p.enabled) {
    return (
      <div className="space-y-12">
        <section className="flex flex-wrap items-baseline justify-between gap-4 border-y border-line py-6">
          <div>
            <p className="plaque">STATUS</p>
            <p className="mt-2 text-lg tracking-[0.08em]">有効</p>
          </div>
          <dl className="grid grid-cols-[auto_auto] gap-x-6 gap-y-1 text-sm">
            <dt className="text-muted">設定日時</dt>
            <dd className="tabular-nums">{p.enabledAtLabel}</dd>
            <dt className="text-muted">未使用のリカバリーコード</dt>
            <dd className="tabular-nums">{p.recoveryRemaining} / 10</dd>
          </dl>
          {p.recoveryRemaining <= 2 && (
            <p role="status" className="basis-full border-l-2 border-warn py-1 pl-3 text-sm text-warn">
              {p.recoveryRemaining === 0 ? "リカバリーコードがありません。" : `リカバリーコードが残り ${p.recoveryRemaining} 個です。`}
              スマートフォンをなくすとログインできなくなるので、下の「作り直す」で新しいコードを控えてください。
            </p>
          )}
        </section>

        <section className="space-y-4">
          <h2 className="h2">リカバリーコードを作り直す</h2>
          <p className="text-sm leading-relaxed text-muted">
            控えをなくしたときや、残りが少なくなったときに。作り直すと、これまでのコードはすべて使えなくなります。
          </p>
          <form action={regenAction} className="flex flex-wrap items-end gap-3">
            <div className="w-48">
              <label htmlFor="regen-code" className="label">認証アプリのコード</label>
              <input id="regen-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required className="input tabular-nums tracking-[0.3em]" />
            </div>
            <SubmitButton className="btn-ghost">作り直す</SubmitButton>
          </form>
          <FormMessage state={regen} />
        </section>

        <section className="space-y-4 border-t border-line pt-10">
          <h2 className="h2">無効にする</h2>
          {p.canDisable ? (
            <form action={disableAction} className="space-y-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label htmlFor="disable-password" className="label">パスワード</label>
                  <input id="disable-password" name="password" type="password" autoComplete="current-password" required className="input" />
                </div>
                <div>
                  <label htmlFor="disable-code" className="label">確認コード</label>
                  <input id="disable-code" name="code" autoComplete="one-time-code" required className="input tabular-nums" />
                  <p className="hint">認証アプリの 6 桁、またはリカバリーコード</p>
                </div>
              </div>
              <FormMessage state={disable} />
              <SubmitButton className="btn-danger">2 段階認証を無効にする</SubmitButton>
            </form>
          ) : (
            <p className="text-sm text-muted">管理者は 2 段階認証を無効にできません。スマートフォンを替えるときは、認証アプリの移行機能を使うか、運営者に解除を依頼してください。</p>
          )}
        </section>
      </div>
    );
  }

  // 設定途中の鍵はサーバーに残さない。再読み込みしたら「設定を始める」からやり直す
  const setup = begin?.setup;
  if (!setup) {
    return (
      <section className="space-y-6">
        <ol className="space-y-3 text-sm leading-relaxed">
          <Step n={1}>スマートフォンに認証アプリを入れる（Google Authenticator、1Password、Microsoft Authenticator など）</Step>
          <Step n={2}>画面の QR コードをアプリで読み取る</Step>
          <Step n={3}>アプリに出た 6 桁のコードを入力して確認する</Step>
        </ol>
        {p.needsTicket && <p className="text-sm leading-relaxed text-muted">管理者の設定には、運営者が発行する設定チケット（30 分有効）も必要です。先に受け取っておいてください。</p>}
        <form action={beginAction}>
          <SubmitButton className="btn-primary" pendingText="準備中…">設定を始める</SubmitButton>
        </form>
        <FormMessage state={begin} />
      </section>
    );
  }

  return (
    <div className="grid gap-12 md:grid-cols-[auto_minmax(0,1fr)]">
      <section className="space-y-4">
        <p className="plaque">STEP 1</p>
        <h2 className="h2">認証アプリで読み取る</h2>
        <QrCode cells={setup.qr} label="認証アプリに登録する QR コード" />
        <ManualKey secret={setup.secret} />
      </section>
      <section className="space-y-4">
        <p className="plaque">STEP 2</p>
        <h2 className="h2">コードを入力して確認する</h2>
        <form action={confirmAction} className="space-y-4">
          <input type="hidden" name="setupToken" value={setup.token} />
          <div>
            <label htmlFor="mfa-code" className="label">認証アプリの 6 桁のコード</label>
            <input id="mfa-code" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required className="input tabular-nums tracking-[0.3em]" />
          </div>
          <div>
            <label htmlFor="mfa-password" className="label">パスワード</label>
            <input id="mfa-password" name="password" type="password" autoComplete="current-password" required className="input" />
            <p className="hint">本人の操作であることを確かめるために使います。</p>
          </div>
          {p.needsTicket && (
            <div>
              <label htmlFor="mfa-ticket" className="label">設定チケット</label>
              <input id="mfa-ticket" name="ticket" autoComplete="off" spellCheck={false} required className="input font-mono text-[13px]" />
              <p className="hint">運営者が発行した文字列を貼り付けてください。</p>
            </div>
          )}
          <FormMessage state={confirm} />
          <SubmitButton className="btn-primary" pendingText="確認中…">確認して有効にする</SubmitButton>
          <p className="hint">有効にすると、この端末以外からはログアウトされます。確認は 15 分以内に行ってください。</p>
        </form>
      </section>
    </div>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-4">
      <span className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line-strong text-xs tabular-nums text-muted">{n}</span>
      <span>{children}</span>
    </li>
  );
}

function ManualKey({ secret }: { secret: string }) {
  const grouped = secret.match(/.{1,4}/g)!.join(" ");
  return (
    <details className="max-w-[208px] text-sm">
      <summary className="btn-link cursor-pointer">読み取れないときは</summary>
      <p className="mt-3 text-xs leading-relaxed text-muted">アプリで「キーを入力」を選び、次の文字列を入力してください（種類：時間ベース）。</p>
      <code data-testid="mfa-secret" data-secret={secret} className="mt-2 block break-all border border-line bg-light px-3 py-2 font-mono text-[13px] tracking-[0.08em]">
        {grouped}
      </code>
    </details>
  );
}

function RecoveryCodes({ codes, adminAfter }: { codes: string[]; adminAfter: boolean }) {
  const [copied, setCopied] = useState(false);
  const text = codes.join("\n");
  return (
    <section className="space-y-6" aria-labelledby="recovery-title">
      <div>
        <p className="plaque">RECOVERY CODES</p>
        <h2 id="recovery-title" className="h1 mt-2">リカバリーコードを控えてください</h2>
        <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">
          スマートフォンをなくしたときに、認証アプリのコードの代わりに 1 回ずつ使えます。この画面を閉じると二度と表示できません。
          パスワード管理アプリに保存するか、印刷して安全な場所に保管してください。
        </p>
      </div>
      <ol data-testid="recovery-codes" className="grid max-w-md grid-cols-2 gap-x-8 gap-y-2 border-y border-line py-6 font-mono text-[15px] tracking-[0.08em] tabular-nums">
        {codes.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-4">
        <button
          type="button"
          className="btn-ghost"
          onClick={() => {
            navigator.clipboard?.writeText(text).then(
              () => setCopied(true),
              () => setCopied(false),
            );
          }}
        >
          {copied ? "コピーしました" : "すべてコピー"}
        </button>
        <a href={adminAfter ? "/admin" : "/settings/security"} className="btn-primary">
          控えました
        </a>
      </div>
    </section>
  );
}
