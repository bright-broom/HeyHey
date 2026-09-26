import { sql } from "drizzle-orm";
import {
  bigserial,
  check,
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
 * 2 段階認証（TOTP）。enabledAt が null の行は「設定途中」（QR を表示して確認コード待ち）。
 * 秘密鍵は MFA_ENCRYPTION_KEY で暗号化して持つ（lib/secretbox）。
 */
export const userMfa = pgTable("user_mfa", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  secretEnc: text("secret_enc").notNull(),
  enabledAt: ts("enabled_at"),
  /** 最後に受け付けた TOTP のステップ。これ以下は受け付けない（リプレイ防止） */
  lastUsedStep: integer("last_used_step"),
  createdAt: createdAt(),
});

/** リカバリーコード。ハッシュだけを持ち、1 回使うと usedAt が入る */
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

export const posts = pgTable(
  "posts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    authorId: uuid("author_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    visibility: postVisibility("visibility").notNull().default("members"),
    hiddenAt: ts("hidden_at"),
    hiddenReason: text("hidden_reason"),
    deletedAt: ts("deleted_at"),
    editedAt: ts("edited_at"),
    createdAt: createdAt(),
  },
  (t) => [index("posts_created_idx").on(t.createdAt), index("posts_author_idx").on(t.authorId, t.createdAt)],
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
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

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

export type User = typeof users.$inferSelect;
export type Post = typeof posts.$inferSelect;
export type Comment = typeof comments.$inferSelect;
export type Report = typeof reports.$inferSelect;
