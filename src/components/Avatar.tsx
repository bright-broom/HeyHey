/** アバター。画像は認証付きの /api/media 経由でしか取れない */
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
        className="shrink-0 rounded-full bg-canvas object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-brand-soft font-bold text-brand"
      style={{ width: size, height: size, fontSize: size * 0.42 }}
    >
      {initial}
    </span>
  );
}
