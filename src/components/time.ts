const fmt = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

export function formatDateTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  return fmt.format(new Date(d));
}

/** 「3 分前」「2 日前」のような相対表記。1 週間を超えたら日時 */
export function timeAgo(d: Date | string): string {
  const diff = (Date.now() - new Date(d).getTime()) / 1000;
  if (diff < 60) return "たった今";
  if (diff < 3600) return `${Math.floor(diff / 60)} 分前`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 時間前`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)} 日前`;
  return formatDateTime(d);
}
