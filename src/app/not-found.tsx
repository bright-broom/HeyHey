import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-md px-4 py-20 text-center">
      <h1 className="h1">ページが見つかりません</h1>
      <p className="mt-3 text-sm text-muted">削除されたか、閲覧できる範囲の外にある可能性があります。</p>
      <Link href="/" className="btn-primary mt-6">ホームへ戻る</Link>
    </main>
  );
}
