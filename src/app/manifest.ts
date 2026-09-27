import type { MetadataRoute } from "next";

/**
 * ホーム画面に追加して、アプリのように開けるようにする（Phase 3 のアプリ化）。
 * オフライン用のキャッシュ（Service Worker）は置かない：非公開の中身を端末に残さないため。
 * 名前と説明は一般名だけ（コミュニティの中身は出さない）。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Kakomi",
    short_name: "Kakomi",
    description: "招待制のメンバー限定コミュニティ",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#eceae6",
    theme_color: "#2e5b86",
    lang: "ja",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
