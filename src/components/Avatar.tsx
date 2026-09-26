/** アバター。円はセパ穴と同じく、直角の画面の中の数少ない例外。画像は認証付きの /api/media 経由 */
export function Avatar({ name, mediaId, size = 40 }: { name: string; mediaId?: string | null; size?: number }) {
  const initial = Array.from(name.trim())[0] ?? "?";
  if (mediaId) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={`/api/media/${mediaId}`}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full bg-concrete object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-concrete font-medium text-ink"
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {initial}
    </span>
  );
}
