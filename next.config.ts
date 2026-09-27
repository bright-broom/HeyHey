import type { NextConfig } from "next";

const isProd = process.env.NODE_ENV === "production";

// クローズド SNS なので、全レスポンスに「検索エンジンに載せない」「他サイトに埋め込ませない」
// 「招待トークン入りの URL を Referer で漏らさない」ヘッダーを付ける。
const securityHeaders = [
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive, nosnippet, noimageindex" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
  ...(isProd
    ? [
        { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" },
        {
          key: "Content-Security-Policy",
          value: [
            "default-src 'self'",
            "script-src 'self' 'unsafe-inline'",
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' blob: data:",
            "font-src 'self'",
            // 動画・ファイルは、ブラウザから Vercel Blob（private）の一時置き場へ直接上げる
            "connect-src 'self' https://vercel.com",
            "media-src 'self'",
            "object-src 'none'",
            "base-uri 'self'",
            "form-action 'self'",
            "frame-ancestors 'none'",
          ].join("; "),
        },
      ]
    : []),
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  serverExternalPackages: ["@electric-sql/pglite", "sharp", "pg"],
  experimental: {
    serverActions: {
      // 画像 4 枚（各 8MB まで）＋フォーム項目の余裕分
      bodySizeLimit: "34mb",
    },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
