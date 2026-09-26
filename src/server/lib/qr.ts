import "server-only";
import { encode } from "uqr";

/** QR コードのセル（true＝黒）。周囲の余白（クワイエットゾーン）4 セル分を含む */
export function qrMatrix(text: string): boolean[][] {
  return encode(text, { ecc: "M", border: 4 }).data;
}
