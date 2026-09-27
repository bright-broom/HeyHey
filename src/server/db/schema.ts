import { sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const createdAt = () => ts("created_at").notNull().defaultNow();

// ───────── 列挙型 ─────────

/** unverified=メール未確認 / pending=申請中 / active=会員 / suspended=停止 / rejected=却下 / withdrawn=退会 */
export const userStatus = pgEnum("user_status", [
  "unverified",
  "pending",
  "active",
  "suspended",
  "rejected",
  "withdrawn",
]);
export const userRole = pgEnum("user_role", ["member", "admin", "owner"]);
export const applicationStatus = pgEnum("application_status", ["pending", "on_hold", "approved", "rejected"]);
/** members=全会員 / friends=友達のみ（グループは Phase 2 で追加） */
export const postVisibility = pgEnum("post_visibility", ["members", "friends"]);
export const reactionType = pgEnum("reaction_type", ["like", "thanks", "wow"]);
export const friendshipStatus = pgEnum("friendship_status", ["pending", "accepted"]);
export const reportTarget = pgEnum("report_target", ["post", "comment", "user"]);
export const reportReason = pgEnum("report_reason", ["spam", "harassment", "inappropriate", "privacy", "other"]);
export const reportStatus = pgEnum("report_status", ["open", "resolved"]);
export const reportResolution = pgEnum("report_resolution", ["dismissed", "hidden", "warned", "suspended"]);
export const mediaKind = pgEnum("media_kind", ["post", "avatar"]);
/** open=誰でもすぐ参加 / approval=管理役の承認が必要。どちらも投稿はメンバーにしか見えない */
export const groupJoinPolicy = pgEnum("group_join_policy", ["open", "approval"]);
export const groupRole = pgEnum("group_role", ["owner", "moderator", "member"]);
export const groupMemberStatus = pgEnum("group_member_status", ["active", "pending"]);

// ───────── 会員・認証 ─────────

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull(),
    passwordHash: text("password_hash").notNull(),
    displayName: text("display_name").notNull(),
    status: userStatus("status").notNull().default("unverified"),
    role: userRole("role").notNull().default("member"),
    invitedById: uuid("invited_by_id"),
    invitationId: uuid("invitation_id"),
    inviteQuotaOverride: integer("invite_quota_override"),
    emailVerifiedAt: ts("email_verified_at"),
    termsAcceptedAt: ts("terms_accepted_at"),
    approvedAt: ts("approved_at"),
    rejectedAt: ts("rejected_at"),
    suspendedAt: ts("suspended_at"),
    suspendedReason: text("suspended_reason"),
    withdrawnAt: ts("withdrawn_at"),
    lastSeenAt: ts("last_seen_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("users_email_key").on(t.email),
    index("users_status_idx").on(t.status),
    index("users_invited_by_idx").on(t.invitedById),
  ],
);

export const profiles = pgTable("profiles", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  bio: text("bio").notNull().default(""),
  affiliation: text("affiliation").notNull().default(""),
  avatarMediaId: uuid("avatar_media_id"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const sessions = pgTable(
  "sessions",
  {
    /** Cookie のトークンそのものは保存せず、SHA-256 ハッシュだけを持つ */
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("sessions_user_idx").on(t.userId)],
);

/**
 * 2 段階認証（TOTP）。行があれば有効。設定途中の鍵は DB に置かない（services/mfa の setupToken）。
 * 秘密鍵は MFA_ENCRYPTION_KEY で暗号化して持つ（lib/secretbox）。
 */
export const userMfa = pgTable("user_mfa", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  secretEnc: text("secret_enc").notNull(),
  enabledAt: ts("enabled_at").notNull().defaultNow(),
  /** 最後に受け付けた TOTP のステップ。これ以下は受け付けない（リプレイ防止） */
  lastUsedStep: integer("last_used_step"),
  createdAt: createdAt(),
});

/** リカバリーコード。サーバー鍵での HMAC だけを持ち、1 回使うと usedAt が入る */
export const mfaRecoveryCodes = pgTable(
  "mfa_recovery_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    usedAt: ts("used_at"),
    createdAt: createdAt(),
  },
  (t) => [index("mfa_recovery_codes_user_idx").on(t.userId)],
);

/**
 * パスワードは通ったが 2 段階目がまだのログイン。セッションとは別のテーブルにして、
 * 「半分だけ認証された」状態がセッションとして扱われる経路を構造的になくす。
 */
export const loginChallenges = pgTable(
  "login_challenges",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    attempts: integer("attempts").notNull().default(0),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("login_challenges_user_idx").on(t.userId)],
);

export const emailTokens = pgTable("email_tokens", {
  tokenHash: text("token_hash").primaryKey(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  purpose: text("purpose").notNull(),
  expiresAt: ts("expires_at").notNull(),
  usedAt: ts("used_at"),
  createdAt: createdAt(),
});

export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  windowStartedAt: ts("window_started_at").notNull().defaultNow(),
});

// ───────── 招待・申請 ─────────

export const invitations = pgTable(
  "invitations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tokenHash: text("token_hash").notNull(),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id),
    note: text("note").notNull().default(""),
    maxUses: integer("max_uses").notNull().default(1),
    useCount: integer("use_count").notNull().default(0),
    expiresAt: ts("expires_at").notNull(),
    revokedAt: ts("revoked_at"),
    revokedById: uuid("revoked_by_id"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("invitations_token_key").on(t.tokenHash), index("invitations_creator_idx").on(t.createdById)],
);

export const applications = pgTable(
  "applications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    fullName: text("full_name").notNull(),
    affiliation: text("affiliation").notNull(),
    relationship: text("relationship").notNull(),
    introduction: text("introduction").notNull(),
    status: applicationStatus("status").notNull().default("pending"),
    reviewerId: uuid("reviewer_id"),
    decisionReason: text("decision_reason"),
    decidedAt: ts("decided_at"),
    createdAt: createdAt(),
  },
  (t) => [index("applications_status_idx").on(t.status), index("applications_user_idx").on(t.userId)],
);

// ───────── コンテンツ ─────────

/**
 * グループ（F-15）。名前と説明は全会員に見せ、投稿はそのグループのアクティブなメンバーにだけ見せる
 * （判定は lib/visibility の visiblePost）。閉じたグループ（archivedAt あり）の投稿は誰にも見せない。
 */
export const groups = pgTable(
  "groups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    joinPolicy: groupJoinPolicy("join_policy").notNull().default("approval"),
    createdById: uuid("created_by_id")
      .notNull()
      .references(() => users.id),
    archivedAt: ts("archived_at"),
    createdAt: createdAt(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("groups_created_idx").on(t.createdAt)],
);

export const groupMembers = pgTable(
  "group_members",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: groupRole("role").notNull().default("member"),
    status: groupMemberStatus("status").notNull().default("pending"),
    createdAt: createdAt(),
    approvedAt: ts("approved_at"),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index("group_members_user_idx").on(t.userId),
    // オーナーは 1 グループに 1 人（移譲・管理者の指定が同時に起きても、DB が 2 人目を拒む）
    uniqueIndex("group_members_one_owner_key").on(t.groupId).where(sql`${t.role} = 'owner'`),
  ],
);

/** グループから外された人。管理役が解除するまで、参加も申請もできない */
export const groupBans = pgTable(
  "group_bans",
  {
    groupId: uuid("group_id")
      .notNull()
      .references(() => groups.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    bannedById: uuid("banned_by_id").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.groupId, t.userId] })],
);

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    /** グループの投稿ならそのグループ。null ならコミュニティ全体（visibility に従う） */
    groupId: uuid("group_id").references(() => groups.id),
    body: text("body").notNull(),
    visibility: postVisibility("visibility").notNull().default("members"),
    hiddenAt: ts("hidden_at"),
    hiddenReason: text("hidden_reason"),
    deletedAt: ts("deleted_at"),
    editedAt: ts("edited_at"),
    createdAt: createdAt(),
  },
  (t) => [index("posts_created_idx").on(t.createdAt), index("posts_author_idx").on(t.authorId, t.createdAt), index("posts_group_idx").on(t.groupId, t.createdAt)],
);

/** 投稿のハッシュタグ（本文から抜き出して保存。タグの一覧も公開範囲の判定を通す） */
export const postTags = pgTable(
  "post_tags",
  {
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    tag: text("tag").notNull(),
  },
  (t) => [primaryKey({ columns: [t.postId, t.tag] }), index("post_tags_tag_idx").on(t.tag)],
);

export const media = pgTable(
  "media",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => users.id),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
    kind: mediaKind("kind").notNull(),
    storageKey: text("storage_key").notNull(),
    mime: text("mime").notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    bytes: integer("bytes").notNull(),
    position: integer("position").notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [index("media_post_idx").on(t.postId)],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    postId: uuid("post_id")
      .notNull()
      .references(() => posts.id, { onDelete: "cascade" }),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    parentId: uuid("parent_id"),
    body: text("body").notNull(),
    hiddenAt: ts("hidden_at"),
    hiddenReason: text("hidden_reason"),
    deletedAt: ts("deleted_at"),
    createdAt: createdAt(),
  },
  (t) => [index("comments_post_idx").on(t.postId, t.createdAt)],
);

export const reactions = pgTable(
  "reactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    postId: uuid("post_id").references(() => posts.id, { onDelete: "cascade" }),
    commentId: uuid("comment_id").references(() => comments.id, { onDelete: "cascade" }),
    type: reactionType("type").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    check("reactions_one_target", sql`(${t.postId} IS NULL) <> (${t.commentId} IS NULL)`),
    uniqueIndex("reactions_user_post_key").on(t.userId, t.postId).where(sql`${t.postId} IS NOT NULL`),
    uniqueIndex("reactions_user_comment_key").on(t.userId, t.commentId).where(sql`${t.commentId} IS NOT NULL`),
  ],
);

export const friendships = pgTable(
  "friendships",
  {
    requesterId: uuid("requester_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    addresseeId: uuid("addressee_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    status: friendshipStatus("status").notNull().default("pending"),
    respondedAt: ts("responded_at"),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.requesterId, t.addresseeId] }),
    check("friendships_not_self", sql`${t.requesterId} <> ${t.addresseeId}`),
    index("friendships_addressee_idx").on(t.addresseeId),
    // A→B と B→A の二重申請を DB レベルで防ぐ
    uniqueIndex("friendships_pair_key").on(
      sql`LEAST(${t.requesterId}, ${t.addresseeId})`,
      sql`GREATEST(${t.requesterId}, ${t.addresseeId})`,
    ),
  ],
);

// ───────── 通知・通報・監査 ─────────

/**
 * ブロック（双方向に見えなくなる）。blocker が blocked をブロックした。
 * 公開範囲の判定（lib/visibility）がこの表を見て、お互いの投稿・コメント・プロフィールを隠す。
 */
export const userBlocks = pgTable(
  "user_blocks",
  {
    blockerId: uuid("blocker_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    blockedId: uuid("blocked_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.blockerId, t.blockedId] }), index("user_blocks_blocked_idx").on(t.blockedId), check("user_blocks_not_self", sql`${t.blockerId} <> ${t.blockedId}`)],
);

/** ミュート（一方向・相手には伝わらない）。muter のホームのフィードと通知から muted を外す */
export const userMutes = pgTable(
  "user_mutes",
  {
    muterId: uuid("muter_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    mutedId: uuid("muted_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.muterId, t.mutedId] }), check("user_mutes_not_self", sql`${t.muterId} <> ${t.mutedId}`)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: text("type").notNull(),
    actorId: uuid("actor_id"),
    postId: uuid("post_id"),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    readAt: ts("read_at"),
    /** メールで知らせた日時（まとめて 1 通にするため、送ったものに印を付ける） */
    emailedAt: ts("emailed_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

/**
 * メールでのお知らせの設定（F-19）。行がなければ既定値（どちらも受け取る）。
 * メールには投稿の中身も人の名前も書かず、件数とリンクだけを送る。
 */
export const notificationPrefs = pgTable("notification_prefs", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  emailInstant: boolean("email_instant").notNull().default(true),
  emailDigest: boolean("email_digest").notNull().default(true),
  lastEmailAt: ts("last_email_at"),
  lastDigestAt: ts("last_digest_at"),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    reporterId: uuid("reporter_id")
      .notNull()
      .references(() => users.id),
    targetType: reportTarget("target_type").notNull(),
    targetId: uuid("target_id").notNull(),
    targetUserId: uuid("target_user_id").notNull(),
    reason: reportReason("reason").notNull(),
    detail: text("detail").notNull().default(""),
    status: reportStatus("status").notNull().default("open"),
    resolution: reportResolution("resolution"),
    resolvedById: uuid("resolved_by_id"),
    resolvedAt: ts("resolved_at"),
    note: text("note"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("reports_once_per_reporter_key").on(t.reporterId, t.targetType, t.targetId),
    index("reports_status_idx").on(t.status, t.createdAt),
    index("reports_target_idx").on(t.targetType, t.targetId),
  ],
);

/** 追記専用。UPDATE / DELETE はマイグレーションのトリガーで拒否する */
export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    actorId: uuid("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    reason: text("reason"),
    meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
  },
  (t) => [index("audit_logs_created_idx").on(t.createdAt)],
);

export const mailOutbox = pgTable("mail_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  to: text("to").notNull(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  provider: text("provider").notNull(),
  createdAt: createdAt(),
});

/**
 * 利用状況の日ごとの記録（毎日の定期処理で 1 行）。人数だけを持ち、誰がかは持たない。
 * 最終アクセス日時は上書きされるので、週次アクティブ率の推移はここにしか残らない（Phase を進める判断に使う）。
 */
export const activitySnapshots = pgTable("activity_snapshots", {
  /** 日本時間の日付 */
  day: date("day", { mode: "string" }).primaryKey(),
  activeMembers: integer("active_members").notNull(),
  /** 記録した時点から直近 7 日にアクセスした会員 */
  weeklyActiveMembers: integer("weekly_active_members").notNull(),
  postsWeek: integer("posts_week").notNull(),
  commentsWeek: integer("comments_week").notNull(),
  createdAt: createdAt(),
});

export type User = typeof users.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type Report = typeof reports.$inferSelect;
