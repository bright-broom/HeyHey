import type { Metadata, Viewport } from "next";
import "./globals.css";

// 本文や会員情報を OGP・検索結果に出さない。タイトルも一般名だけにする
export const metadata: Metadata = {
  title: { default: "Kakomi", template: "%s | Kakomi" },
  description: "招待制のメンバー限定コミュニティ",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
  referrer: "no-referrer",
  appleWebApp: { capable: true, title: "Kakomi", statusBarStyle: "default" },
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#2e5b86" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ja">
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
