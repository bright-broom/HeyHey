import Link from "next/link";
import { FlashToast } from "@/components/Flash";
import { readFlash } from "@/server/web/flash";

export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col items-center px-4 py-10">
      <Link href="/" className="mb-6 text-2xl font-extrabold tracking-tight text-brand">
        Kakomi
      </Link>
      <main className="w-full max-w-lg">{children}</main>
      <footer className="mt-10 flex gap-4 text-xs text-muted">
        <Link href="/terms" className="hover:underline">利用規約</Link>
        <Link href="/privacy" className="hover:underline">プライバシーポリシー</Link>
      </footer>
      <FlashToast flash={await readFlash()} />
    </div>
  );
}
