/**
 * 初期データ投入。
 *   npm run db:seed            … オーナーアカウントを 1 つ作る（会員が 0 人のときだけ）
 *   npm run db:seed -- --demo  … 動作確認用のデモ会員・投稿・申請・通報も作る
 *
 * オーナーは OWNER_EMAIL / OWNER_PASSWORD / OWNER_NAME で指定できる。
 * パスワード未指定なら安全な乱数で生成して 1 回だけ表示する。
 */
import { randomBytes } from "node:crypto";
import sharp from "sharp";
import { eq, sql } from "drizzle-orm";
import { closeDb, getDb, type Db } from "../src/server/db/client";
import { applications, friendships, profiles, userMfa, users } from "../src/server/db/schema";
import { hashPassword } from "../src/server/lib/password";
import { seal } from "../src/server/lib/secretbox";
import { sealAad } from "../src/server/services/mfa";
import { toViewer } from "../src/server/lib/viewer";
import { createPost, addComment, toggleReaction } from "../src/server/services/posts";
import { createReport } from "../src/server/services/reports";

const DEMO_PASSWORD = "demo-password-123";
/** デモのオーナー・管理者の 2 段階認証の鍵（ローカル専用。認証アプリに手入力すればコードが出る） */
const DEMO_TOTP_SECRET = "KAKOMIDEMOKAKOMIDEMOKAKOMIDEMO23";

async function createUser(db: Db, o: { email: string; name: string; password: string; role?: "member" | "admin" | "owner"; status?: "active" | "pending"; invitedById?: string | null; affiliation?: string; bio?: string }) {
  const now = new Date();
  const status = o.status ?? "active";
  const [u] = await db
    .insert(users)
    .values({
      email: o.email.toLowerCase(),
      passwordHash: await hashPassword(o.password),
      displayName: o.name,
      role: o.role ?? "member",
      status,
      invitedById: o.invitedById ?? null,
      emailVerifiedAt: now,
      approvedAt: status === "active" ? new Date(now.getTime() - 14 * 86400_000) : null,
      termsAcceptedAt: status === "active" ? now : null,
    })
    .returning();
  await db.insert(profiles).values({ userId: u!.id, affiliation: o.affiliation ?? "", bio: o.bio ?? "" });
  return u!;
}

async function main() {
  const demo = process.argv.includes("--demo");
  // デモ用の既知のパスワード・2 段階認証の鍵を、本番の DB に入れてしまわないように
  if (demo && (process.env.DATABASE_URL || process.env.VERCEL)) {
    console.error("--demo はローカル（PGlite）専用です。DATABASE_URL を外して実行してください。");
    process.exit(1);
  }
  const db = await getDb();
  const [{ n } = { n: 0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(users);

  if (n === 0) {
    const email = process.env.OWNER_EMAIL ?? "owner@example.com";
    const password = process.env.OWNER_PASSWORD ?? (demo ? DEMO_PASSWORD : randomBytes(12).toString("base64url"));
    const name = process.env.OWNER_NAME ?? "オーナー";
    await createUser(db, { email, name, password, role: "owner", affiliation: "運営" });
    console.log("✓ オーナーを作成しました");
    console.log(`  メール     : ${email}`);
    if (!process.env.OWNER_PASSWORD) console.log(`  パスワード : ${password}${demo ? "" : "   ← この表示は 1 回だけです。控えてください"}`);
  } else {
    console.log(`・会員が ${n} 人いるため、オーナーの作成はスキップしました`);
  }

  if (demo) await seedDemo(db);
  await closeDb();
}

async function seedDemo(db: Db) {
  const [exists] = await db.select({ id: users.id }).from(users).where(eq(users.email, "sato@example.com"));
  if (exists) {
    console.log("・デモデータは作成済みです");
    return;
  }
  const [owner] = await db.select().from(users).where(eq(users.role, "owner")).limit(1);
  const admin = await createUser(db, { email: "admin@example.com", name: "管理 花子", password: DEMO_PASSWORD, role: "admin", invitedById: owner!.id, affiliation: "運営チーム", bio: "入会審査と通報対応を担当しています。" });
  for (const u of [owner!, admin]) {
    await db.insert(userMfa).values({ userId: u.id, secretEnc: seal(DEMO_TOTP_SECRET, sealAad(u.id)), enabledAt: new Date() }).onConflictDoNothing();
  }
  const sato = await createUser(db, { email: "sato@example.com", name: "佐藤 健", password: DEMO_PASSWORD, invitedById: owner!.id, affiliation: "株式会社サンプル", bio: "週末は山登りをしています。" });
  const tanaka = await createUser(db, { email: "tanaka@example.com", name: "田中 美咲", password: DEMO_PASSWORD, invitedById: sato.id, affiliation: "デザイン事務所", bio: "UI デザイナー。写真も好きです。" });
  const suzuki = await createUser(db, { email: "suzuki@example.com", name: "鈴木 大輔", password: DEMO_PASSWORD, invitedById: sato.id, affiliation: "フリーランス" });
  const yamada = await createUser(db, { email: "yamada@example.com", name: "山田 太郎", password: DEMO_PASSWORD, status: "pending", invitedById: tanaka.id });
  await db.insert(applications).values({
    userId: yamada.id,
    fullName: "山田 太郎",
    affiliation: "サンプル大学",
    relationship: "田中さんの大学時代の友人",
    introduction: "田中さんから紹介してもらいました。写真と旅行が好きです。よろしくお願いします。",
    createdAt: new Date(Date.now() - 80 * 3600_000),
  });

  await db.insert(friendships).values([
    { requesterId: sato.id, addresseeId: tanaka.id, status: "accepted", respondedAt: new Date() },
    { requesterId: tanaka.id, addresseeId: owner!.id, status: "accepted", respondedAt: new Date() },
    { requesterId: suzuki.id, addresseeId: owner!.id, status: "pending" },
  ]);

  const v = (u: typeof sato) => toViewer(u);
  const photo = (bg: string) => sharp({ create: { width: 1200, height: 800, channels: 3, background: bg } }).jpeg().toBuffer();

  const p1 = await createPost(db, v(owner!), { body: "Kakomi へようこそ。\nここは招待されたメンバーだけの場所です。気軽に近況を共有してください。", visibility: "members" });
  const p2 = await createPost(db, v(sato), { body: "週末に高尾山へ行ってきました。紅葉にはまだ少し早かったです。", visibility: "members", images: [await photo("#6a8f5a"), await photo("#c9a15b")] });
  const p3 = await createPost(db, v(tanaka), { body: "来月、個展をやることになりました。まずは友達にだけお知らせです。", visibility: "friends" });
  await createPost(db, v(suzuki), { body: "おすすめの技術書があれば教えてください。", visibility: "members" });

  const c1 = await addComment(db, v(tanaka), { postId: p2.id, body: "写真きれい！次は誘ってください。" });
  await addComment(db, v(sato), { postId: p2.id, body: "ぜひ一緒に行きましょう。", parentId: c1.id });
  await addComment(db, v(owner!), { postId: p3.id, body: "おめでとうございます！" });
  await toggleReaction(db, v(tanaka), { postId: p2.id }, "like");
  await toggleReaction(db, v(owner!), { postId: p2.id }, "wow");
  await toggleReaction(db, v(sato), { postId: p1.id }, "thanks");

  const spam = await createPost(db, v(suzuki), { body: "【副業】誰でも月 50 万円稼げる方法を教えます。DM ください。", visibility: "members" });
  await createReport(db, v(sato), { targetType: "post", targetId: spam.id, reason: "spam", detail: "勧誘目的の投稿に見えます" });
  await createReport(db, v(tanaka), { targetType: "post", targetId: spam.id, reason: "spam" });

  console.log("✓ デモデータを作成しました（パスワードはすべて " + DEMO_PASSWORD + "）");
  console.log("  admin@example.com（管理者） / sato@example.com / tanaka@example.com / suzuki@example.com");
  console.log(`  オーナーと管理者は 2 段階認証が有効。認証アプリに次の鍵を登録してください：${DEMO_TOTP_SECRET}`);
  console.log("  審査待ち：山田 太郎　未処理の通報：1 件");
  void admin;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
