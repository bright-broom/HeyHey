/**
 * オープンリダイレクト対策。制御文字・バックスラッシュを含むものは拒否し、
 * URL として解釈した結果が同一オリジンのパスである場合だけ、そのパス部分を使う。
 */
export function safeLocalPath(next: string): string | null {
  if (!next || next.length > 500 || !next.startsWith("/") || /[\u0000-\u001f\u007f\\]/.test(next)) return null;
  try {
    const base = "http://kakomi.invalid";
    const u = new URL(next, base);
    if (u.origin !== base) return null;
    return `${u.pathname}${u.search}`;
  } catch {
    return null;
  }
}
