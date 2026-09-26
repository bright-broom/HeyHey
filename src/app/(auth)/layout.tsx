import Link from "next/link";
import { FlashToast } from "@/components/Flash";
import { readFlash } from "@/server/web/flash";

/**
 * 入口。左にコンクリートの壁と一筋の光、右に入力の面。
 * 何の場所に入ろうとしているのかを、言葉より先に空間で伝える。
 */
function LightWall() {
  return (
    <div aria-hidden className="concrete-wall relative h-44 overflow-hidden lg:absolute lg:inset-0 lg:h-auto">
      {/* 室内側の陰 */}
      <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-black/25 to-black/45" />
      {/* 床に落ちる光の帯 */}
      <div className="absolute inset-y-0 left-[62%] w-[38%] bg-gradient-to-r from-[#fff8e6]/25 via-[#fff8e6]/5 to-transparent" />
      {/* 壁のスリットから差す光 */}
      <div className="absolute inset-y-0 left-[62%] w-[3px] -translate-x-1/2 bg-gradient-to-b from-transparent via-[#fffdf6] to-transparent shadow-[0_0_28px_8px_rgba(255,246,222,0.55)]" />
    </div>
  );
}

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="grid min-h-dvh grid-rows-[auto_1fr] lg:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] lg:grid-rows-none">
      <div className="relative bg-[#b7b2aa] lg:sticky lg:top-0 lg:h-dvh">
        <LightWall />
        <div className="absolute inset-x-0 bottom-0 p-6 text-light lg:p-12">
          <p className="text-[11px] tracking-[0.42em]">KAKOMI</p>
          <p className="mt-3 hidden text-2xl font-medium leading-relaxed tracking-[0.12em] lg:block">
            囲まれた、
            <br />
            静かな場所。
          </p>
          <p className="mt-4 hidden max-w-xs text-xs leading-loose tracking-[0.06em] text-light/80 lg:block">
            招待され、承認されたメンバーだけが入れるコミュニティです。ここで話したことは、外には出ていきません。
          </p>
        </div>
      </div>
      <div className="flex flex-col bg-light/60">
        <main className="auth-pane fade-in mx-auto w-full max-w-md flex-1 px-6 py-12 lg:py-24">{children}</main>
        <footer className="mx-auto flex w-full max-w-md gap-6 px-6 pb-8 text-[11px] tracking-[0.08em] text-muted">
          <Link href="/terms" className="hover:text-ink">利用規約</Link>
          <Link href="/privacy" className="hover:text-ink">プライバシーポリシー</Link>
        </footer>
      </div>
      <FlashToast flash={await readFlash()} />
    </div>
  );
}
