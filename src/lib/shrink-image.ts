/**
 * 投稿画像を、送る前にブラウザで縮める（長辺 2048px・JPEG）。
 *
 * 本番（Vercel Functions）はリクエスト本文が 4.5MB までなので、スマホの写真をそのまま送ると
 * 2〜3 枚で上限を超えて投稿できない。サーバー側はこれまでどおり sharp で作り直す
 * （位置情報などはそこで必ず落ちる）ので、ここで縮めるのは送る量を減らすためだけ。
 * 読めない画像や縮めても小さくならない画像は、元のファイルをそのまま返す（判定はサーバーに任せる）。
 */
const MAX_EDGE = 2048;
/** 1 回の送信に入れてよい画像の合計（Vercel の上限 4.5MB から、本文などの余裕を引いた分） */
export const MAX_UPLOAD_TOTAL = 4 * 1024 * 1024;

export async function shrinkImage(file: File): Promise<File> {
  if (!file.type.startsWith("image/") || file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const w = Math.round(bitmap.width * scale);
    const h = Math.round(bitmap.height * scale);
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    canvas.getContext("2d")!.drawImage(bitmap, 0, 0, w, h);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}
