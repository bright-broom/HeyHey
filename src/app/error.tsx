"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="mx-auto max-w-md px-4 py-20 text-center">
      <h1 className="h1">問題が発生しました</h1>
      <p className="mt-3 text-sm text-muted">時間をおいてもう一度お試しください。解決しない場合は管理者に連絡してください。</p>
      <button onClick={reset} className="btn-primary mt-6">再読み込み</button>
    </main>
  );
}
