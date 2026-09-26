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
import { applications, friendships, groupMembers, groups, profiles, userMfa, users, type User } from "../src/server/db/schema";
import { DEMO_ACCOUNTS, DEMO_PASSWORD, DEMO_TOTP_SECRET, type DemoAccount } from "../src/server/lib/demo";
import { hashPassword } from "../src/server/lib/password";
import { seal } from "../src/server/lib/secretbox";
import { sealAad } from "../src/server/services/mfa";
import { toViewer } from "../src/server/lib/viewer";
import { createPost, addComment, toggleReaction } from "../src/server/services/posts";
import { createReport } from "../src/server/services/reports";

const DAY = 86400_000;

async function createUser(db: Db, o: { email: string; name: string; password: string; role?: "member" | "admin" | "owner"; invitedById?: string | null; affiliation?: string; bio?: string }) {
  const now = new Date();
  const [u] = await db
    .insert(users)
    .values({
      email: o.email.toLowerCase(),
      passwordHash: await hashPassword(o.password),
      displayName: o.name,
      role: o.role ?? "member",
      status: "active",
      invitedById: o.invitedById ?? null,
      emailVerifiedAt: now,
      approvedAt: new Date(now.getTime() - 14 * DAY),
      termsAcceptedAt: now,
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

/** 誰の招待で入ったか（招待の系譜を管理画面で確かめられるように） */
const INVITED_BY: Record<string, string> = {
  "admin@example.com": "owner@example.com",
  "admin-new@example.com": "owner@example.com",
  "sato@example.com": "owner@example.com",
  "tanaka@example.com": "sato@example.com",
  "suzuki@example.com": "sato@example.com",
  "takahashi@example.com": "sato@example.com",
  "ito@example.com": "tanaka@example.com",
  "yamada@example.com": "tanaka@example.com",
  "kobayashi@example.com": "suzuki@example.com",
  "nakamura@example.com": "sato@example.com",
  "watanabe@example.com": "suzuki@example.com",
};

/** 申請者・却下された人の申請内容 */
const APPLICATIONS: Record<string, { relationship: string; introduction: string; hoursAgo: number; rejected?: string }> = {
  "yamada@example.com": { relationship: "田中さんの大学時代の友人", introduction: "田中さんから紹介してもらいました。写真と旅行が好きです。よろしくお願いします。", hoursAgo: 80 },
  "kobayashi@example.com": { relationship: "鈴木さんの仕事仲間", introduction: "鈴木さんと一緒にアプリを作っています。", hoursAgo: 2 },
  "watanabe@example.com": { relationship: "知人", introduction: "よろしくお願いします。", hoursAgo: 240, rejected: "招待者との関係を確認できなかったため" },
};

/** 台帳のアカウントを 1 人ずつ用意する。すでにいる人はそのまま使うので、何度流してもよい */
async function ensureDemoAccount(db: Db, a: DemoAccount, byEmail: Map<string, User>): Promise<{ user: User; created: boolean }> {
  const [existing] = a.role === "owner" ? await db.select().from(users).where(eq(users.role, "owner")).limit(1) : await db.select().from(users).where(eq(users.email, a.email));
  let user = existing;
  if (!user) {
    const now = Date.now();
    const active = a.status === "active" || a.status === "suspended";
    const [u] = await db
      .insert(users)
      .values({
        email: a.email,
        passwordHash: await hashPassword(DEMO_PASSWORD),
        displayName: a.name,
        role: a.role,
        status: a.status,
        invitedById: byEmail.get(INVITED_BY[a.email] ?? "")?.id ?? null,
        emailVerifiedAt: a.status === "unverified" ? null : new Date(now - 20 * DAY),
        approvedAt: active ? new Date(now - 14 * DAY) : null,
        termsAcceptedAt: active && !a.termsPending ? new Date(now - 14 * DAY) : null,
        suspendedAt: a.status === "suspended" ? new Date(now - 1 * DAY) : null,
        suspendedReason: a.status === "suspended" ? "勧誘目的の投稿を繰り返したため（デモ）" : null,
        rejectedAt: a.status === "rejected" ? new Date(now - 10 * DAY) : null,
      })
      .returning();
    user = u!;
    await db.insert(profiles).values({ userId: user.id, affiliation: a.affiliation ?? "", bio: a.bio ?? "" });
    const app = APPLICATIONS[a.email];
    if (app) {
      await db.insert(applications).values({
        userId: user.id,
        fullName: a.name,
        affiliation: a.affiliation ?? "",
        relationship: app.relationship,
        introduction: app.introduction,
        createdAt: new Date(now - app.hoursAgo * 3600_000),
        ...(app.rejected
          ? { status: "rejected" as const, decisionReason: app.rejected, reviewerId: byEmail.get("admin@example.com")?.id ?? null, decidedAt: new Date(now - 10 * DAY) }
          : {}),
      });
    }
  }
  if (a.mfa) {
    await db.insert(userMfa).values({ userId: user.id, secretEnc: seal(DEMO_TOTP_SECRET, sealAad(user.id)) }).onConflictDoNothing();
  }
  return { user, created: !existing };
}

async function seedDemo(db: Db) {
  const byEmail = new Map<string, User>();
  const created: DemoAccount[] = [];
  for (const a of DEMO_ACCOUNTS) {
    const r = await ensureDemoAccount(db, a, byEmail);
    byEmail.set(a.email, r.user);
    if (r.created) created.push(a);
  }
  // 投稿などの中身は、会員（佐藤さん）を初めて作ったときだけ入れる
  if (created.some((a) => a.email === "sato@example.com")) await seedContent(db, byEmail);
  await ensureDemoGroups(db, byEmail);

  console.log(created.length ? `✓ デモアカウントを ${created.length} 人追加しました` : "・デモアカウントはすべて作成済みです");
  console.log(`  パスワードはすべて ${DEMO_PASSWORD}。ローカルの開発サーバーでは、ログイン画面の「デモアカウント」から 1 クリックでも入れます`);
  console.log(`  2 段階認証が有効な人（オーナー・管理者・高橋さん）の鍵：${DEMO_TOTP_SECRET}`);
  for (const a of DEMO_ACCOUNTS) console.log(`  ${a.email.padEnd(24)} ${a.label}`);
}

/**
 * デモのグループ（名前で見つかれば作らない）。
 * - 山歩きの会：参加自由。佐藤さんがオーナー、田中さん・高橋さんがメンバー
 * - 読書会：承認制。田中さんがオーナー、鈴木さんが承認待ち（管理役の画面を試せる）
 */
async function ensureDemoGroups(db: Db, byEmail: Map<string, User>) {
  const get = (email: string) => byEmail.get(email)!;
  const defs = [
    { name: "山歩きの会", description: "週末の山歩きの計画と報告。初心者歓迎です。", joinPolicy: "open" as const, owner: "sato@example.com", members: ["tanaka@example.com", "takahashi@example.com"], pending: [], post: "来月は高尾山の稲荷山コースを歩きませんか。" },
    { name: "読書会", description: "月に 1 冊、同じ本を読んで感想を話します。", joinPolicy: "approval" as const, owner: "tanaka@example.com", members: ["owner@example.com"], pending: ["suzuki@example.com"], post: "今月の本は『銀河鉄道の夜』にしましょう。" },
  ];
  let made = 0;
  for (const def of defs) {
    const [exists] = await db.select({ id: groups.id }).from(groups).where(eq(groups.name, def.name));
    if (exists) continue;
    const owner = get(def.owner);
    const [g] = await db.insert(groups).values({ name: def.name, description: def.description, joinPolicy: def.joinPolicy, createdById: owner.id }).returning();
    await db.insert(groupMembers).values([
      { groupId: g!.id, userId: owner.id, role: "owner" as const, status: "active" as const, approvedAt: new Date() },
      ...def.members.map((e) => ({ groupId: g!.id, userId: get(e).id, role: "member" as const, status: "active" as const, approvedAt: new Date() })),
      ...def.pending.map((e) => ({ groupId: g!.id, userId: get(e).id, role: "member" as const, status: "pending" as const })),
    ]);
    await createPost(db, toViewer(owner), { body: def.post, visibility: "members", groupId: g!.id });
    made++;
  }
  if (made) console.log(`✓ デモのグループを ${made} 件作成しました（山歩きの会・読書会）`);
}

async function seedContent(db: Db, byEmail: Map<string, User>) {
  const get = (email: string) => byEmail.get(email)!;
  const [owner, sato, tanaka, suzuki] = [get("owner@example.com"), get("sato@example.com"), get("tanaka@example.com"), get("suzuki@example.com")];
  await db.insert(friendships).values([
    { requesterId: sato.id, addresseeId: tanaka.id, status: "accepted", respondedAt: new Date() },
    { requesterId: tanaka.id, addresseeId: owner.id, status: "accepted", respondedAt: new Date() },
    { requesterId: suzuki.id, addresseeId: owner.id, status: "pending" },
    { requesterId: get("takahashi@example.com").id, addresseeId: sato.id, status: "accepted", respondedAt: new Date() },
  ]);

  const v = (u: User) => toViewer(u);
  const photo = (bg: string) => sharp({ create: { width: 1200, height: 800, channels: 3, background: bg } }).jpeg().toBuffer();

  const p1 = await createPost(db, v(owner), { body: "Kakomi へようこそ。\nここは招待されたメンバーだけの場所です。気軽に近況を共有してください。", visibility: "members" });
  const p2 = await createPost(db, v(sato), { body: "週末に高尾山へ行ってきました。紅葉にはまだ少し早かったです。", visibility: "members", images: [await photo("#6a8f5a"), await photo("#c9a15b")] });
  const p3 = await createPost(db, v(tanaka), { body: "来月、個展をやることになりました。まずは友達にだけお知らせです。", visibility: "friends" });
  await createPost(db, v(suzuki), { body: "おすすめの技術書があれば教えてください。", visibility: "members" });

  const c1 = await addComment(db, v(tanaka), { postId: p2.id, body: "写真きれい！次は誘ってください。" });
  await addComment(db, v(sato), { postId: p2.id, body: "ぜひ一緒に行きましょう。", parentId: c1.id });
  await addComment(db, v(owner), { postId: p3.id, body: "おめでとうございます！" });
  await toggleReaction(db, v(tanaka), { postId: p2.id }, "like");
  await toggleReaction(db, v(owner), { postId: p2.id }, "wow");
  await toggleReaction(db, v(sato), { postId: p1.id }, "thanks");

  const spam = await createPost(db, v(suzuki), { body: "【副業】誰でも月 50 万円稼げる方法を教えます。DM ください。", visibility: "members" });
  await createReport(db, v(sato), { targetType: "post", targetId: spam.id, reason: "spam", detail: "勧誘目的の投稿に見えます" });
  await createReport(db, v(tanaka), { targetType: "post", targetId: spam.id, reason: "spam" });
  console.log("✓ 投稿・コメント・友達・通報（未処理 1 件）を作成しました");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
