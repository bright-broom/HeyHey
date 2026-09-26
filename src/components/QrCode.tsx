/**
 * QR コードを SVG で描く。外部サービスに鍵を送らないよう、サーバーで作ったセルをそのまま描画する。
 * 読み取り精度のため、色はトークンに寄せず白地に黒で固定する。
 */
export function QrCode({ cells, label, size = 208 }: { cells: boolean[][]; label: string; size?: number }) {
  const n = cells.length;
  let d = "";
  cells.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${n} ${n}`} shapeRendering="crispEdges" className="block border border-line">
      <rect width={n} height={n} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
