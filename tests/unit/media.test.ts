import { describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";
import { processImage } from "@/server/services/media";

describe("画像の取り込み", () => {
  it("EXIF（位置情報を含む）を取り除いて WebP に変換する", async () => {
    const withExif = await sharp({ create: { width: 64, height: 32, channels: 3, background: "#f80" } })
      .jpeg()
      .withExif({ IFD0: { Make: "SecretCam", Copyright: "private" }, IFD3: { GPSLatitudeRef: "N", GPSLatitude: "35/1 41/1 0/1" } })
      .toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();

    const out = await processImage(withExif);
    const file = await fs.readFile(path.resolve(process.env.UPLOAD_DIR!, out.key));
    const meta = await sharp(file).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(file.includes(Buffer.from("SecretCam"))).toBe(false);
    expect(out.width).toBe(64);
  });

  it("画像でないファイル（拡張子偽装を含む）は拒否する", async () => {
    await expect(processImage(Buffer.from("<script>alert(1)</script>"))).rejects.toMatchObject({ code: "invalid" });
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>');
    await expect(processImage(svg)).rejects.toMatchObject({ code: "invalid" });
  });

  it("大きすぎる画像は長辺 2048px に縮小する", async () => {
    const big = await sharp({ create: { width: 4000, height: 1000, channels: 3, background: "#000" } }).png().toBuffer();
    const out = await processImage(big);
    expect(out.width).toBe(2048);
    expect(out.height).toBe(512);
  });
});
