import { redirect } from "next/navigation";
import { acceptTermsAction } from "@/app/actions/auth";
import { SubmitButton } from "@/components/SubmitButton";
import { getViewer, homeFor } from "@/server/web/session";
import { TermsBody } from "../terms/page";

export const metadata = { title: "ようこそ" };

export default async function WelcomePage() {
  const v = await getViewer();
  if (!v || v.status !== "active" || v.termsAccepted) redirect(homeFor(v));
  return (
    <div className="card space-y-5 p-6">
      <div>
        <h1 className="h1">{v.displayName} さん、ようこそ</h1>
        <p className="mt-1 text-sm text-muted">入会が承認されました。はじめに利用規約を確認してください。</p>
      </div>
      <div className="max-h-80 overflow-y-auto rounded-lg border border-line p-4 text-sm">
        <TermsBody />
      </div>
      <form action={acceptTermsAction} className="space-y-3">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="agree" required />
          利用規約に同意します
        </label>
        <SubmitButton className="btn-primary w-full">同意してはじめる</SubmitButton>
      </form>
    </div>
  );
}
