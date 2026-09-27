import fs from "node:fs";
import { expect, test, type Browser, type Page } from "@playwright/test";
import sharp from "sharp";
import { totpCode, totpStep } from "../../src/server/lib/totp";

/**
 * 許可制 SNS の一連の流れを、本番ビルド＋ブラウザで通す。
 * 招待 → 登録 → メール確認 → 審査中は何も見えない → 承認 → 規約同意 → 投稿・公開範囲 → 停止で即遮断
 */
test.describe.configure({ mode: "serial" });

const OWNER = { email: "owner@e2e.test", password: "owner-password-123" };
const NEWBIE = { email: "newbie@e2e.test", password: "newbie-password-123" };

let inviteUrl = "";
let mediaUrl = "";
let ownerPage: Page;
let newbiePage: Page;

async function login(page: Page, who: { email: string; password: string }) {
  await page.goto("/login");
  await page.getByLabel("メールアドレス").fill(who.email);
  await page.getByLabel("パスワード").fill(who.password);
  await page.getByRole("button", { name: "ログイン" }).click();
}

async function newPage(browser: Browser) {
  const ctx = await browser.newContext();
  return ctx.newPage();
}

test("未ログインでは何も見えない", async ({ page }) => {
  for (const path of ["/", "/members", "/admin", "/settings/security", "/login/2fa", "/posts/00000000-0000-0000-0000-000000000000"]) {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login/);
  }
  const res = await page.request.get("/api/media/00000000-0000-0000-0000-000000000000");
  expect(res.status()).toBe(404);
  const robots = await page.request.get("/robots.txt");
  expect(await robots.text()).toContain("Disallow: /");
  const html = await page.request.get("/login");
  expect(html.headers()["x-robots-tag"]).toContain("noindex");
});

test("オーナーが画像付きで投稿し、招待リンクを発行する", async ({ browser }) => {
  ownerPage = await newPage(browser);
  await login(ownerPage, OWNER);
  await expect(ownerPage).toHaveURL("/");

  const img = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#2e5b86" } })
    .jpeg()
    .withExif({ IFD0: { Make: "SecretCam" } })
    .toBuffer();
  await ownerPage.getByLabel("本文").fill("オーナーからのお知らせ（全会員向け）");
  await ownerPage.locator('input[name="images"]').setInputFiles({ name: "photo.jpg", mimeType: "image/jpeg", buffer: img });
  await ownerPage.getByRole("button", { name: "投稿する" }).click();
  const post = ownerPage.getByTestId("post").filter({ hasText: "オーナーからのお知らせ" });
  await expect(post).toBeVisible();
  mediaUrl = (await post.locator('img[src^="/api/media/"]').first().getAttribute("src"))!;
  const served = await ownerPage.request.get(mediaUrl);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-type"]).toBe("image/webp");
  expect((await served.body()).includes(Buffer.from("SecretCam"))).toBe(false);

  // 写真は別のタブに移らず、ページの上で拡大する。写真の外を押すと閉じて、元の一覧に戻る
  const tabs = ownerPage.context().pages().length;
  await post.getByRole("link", { name: "写真を拡大" }).click();
  const viewer = ownerPage.getByRole("dialog", { name: "写真" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator("img")).toHaveAttribute("src", mediaUrl);
  expect(ownerPage.context().pages()).toHaveLength(tabs);
  await viewer.locator("img").click(); // 写真そのものを押しても閉じない
  await expect(viewer).toBeVisible();
  await ownerPage.mouse.click(8, 400);
  await expect(viewer).toBeHidden();
  await expect(ownerPage).toHaveURL("/");
  await expect(post).toBeVisible();
  // Esc でも閉じる
  await post.getByRole("link", { name: "写真を拡大" }).click();
  await expect(viewer).toBeVisible();
  await ownerPage.keyboard.press("Escape");
  await expect(viewer).toBeHidden();

  await ownerPage.goto("/invites");
  await ownerPage.getByRole("button", { name: "招待リンクを発行" }).click();
  inviteUrl = await ownerPage.getByTestId("invite-url").inputValue();
  expect(inviteUrl).toMatch(/\/join\/[A-Za-z0-9_-]{40,}$/);
});

test("オーナーも 2 段階認証を設定するまで管理画面に入れない。設定後のログインはコードが必要", async ({ browser }) => {
  await ownerPage.goto("/admin/applications");
  await expect(ownerPage).toHaveURL("/settings/security?required=1");
  await expect(ownerPage.getByText("管理者は 2 段階認証が必須です")).toBeVisible();

  await ownerPage.getByRole("button", { name: "設定を始める" }).click();
  await expect(ownerPage.getByRole("img", { name: "認証アプリに登録する QR コード" })).toBeVisible();
  const secret = (await ownerPage.getByTestId("mfa-secret").getAttribute("data-secret"))!;
  const usedStep = totpStep(Date.now());
  await ownerPage.getByLabel("認証アプリの 6 桁のコード").fill(totpCode(secret, usedStep));
  await ownerPage.getByLabel("パスワード").fill(OWNER.password);
  // 管理者以上は、運営者が発行した設定チケットも要る（playwright.config.ts で発行済み）
  await ownerPage.getByLabel("設定チケット").fill(fs.readFileSync(".data/e2e/owner-ticket.txt", "utf8").trim());
  await ownerPage.getByRole("button", { name: "確認して有効にする" }).click();
  await expect(ownerPage.getByTestId("recovery-codes").locator("li")).toHaveCount(10);
  await ownerPage.getByRole("link", { name: "控えました" }).click();
  await expect(ownerPage).toHaveURL("/admin");

  // 別の端末からログインすると、パスワードの後にコードを求められる
  const p = await newPage(browser);
  await login(p, OWNER);
  await expect(p).toHaveURL("/login/2fa");
  await p.goto("/admin");
  await expect(p).toHaveURL(/\/login/); // コード入力前はセッションがない
  await p.goto("/login/2fa");
  await p.getByLabel("確認コード").fill(totpCode(secret, usedStep + 5));
  await p.getByRole("button", { name: "確認する" }).click();
  await expect(p.getByText("確認コードが正しくありません。")).toBeVisible();
  // 使用済みのステップは受け付けないので、次のステップのコードを使う（±1 ステップは許容範囲）
  await p.getByLabel("確認コード").fill(totpCode(secret, Math.max(totpStep(Date.now()), usedStep + 1)));
  await p.getByRole("button", { name: "確認する" }).click();
  await expect(p).toHaveURL("/");
  await p.goto("/admin");
  await expect(p).toHaveURL("/admin");
  // Phase を進める判断に使う、週次アクティブ率の推移（記録は毎日の定期処理が残す）
  await expect(p.getByRole("heading", { name: "週次アクティブ率の推移" })).toBeVisible();
  await p.context().close();
});

test("招待リンクから申請し、メールで確認する", async ({ browser }) => {
  newbiePage = await newPage(browser);
  const p = newbiePage;
  await p.goto(inviteUrl);
  await expect(p.getByText("さんから招待されています")).toBeVisible();
  await p.getByLabel("メールアドレス").fill(NEWBIE.email);
  await p.getByLabel("パスワード", { exact: true }).fill(NEWBIE.password);
  await p.getByLabel("パスワード（確認）").fill(NEWBIE.password);
  await p.getByLabel("表示名").fill("新人さん");
  await p.getByLabel("氏名").fill("新人 一郎");
  await p.getByLabel("招待者との関係").fill("オーナーの元同僚");
  await p.getByLabel("自己紹介").fill("よろしくお願いします。");
  await p.getByRole("checkbox").check();
  await p.getByRole("button", { name: "申請する" }).click();
  await expect(p).toHaveURL("/join/sent");

  // 同じ招待リンクはもう使えない
  const again = await newPage(browser);
  await again.goto(inviteUrl);
  await expect(again.getByText("招待リンクを確認できません")).toBeVisible();

  await p.goto("/dev/mail");
  const mail = p.locator(`[data-testid="mail"][data-to="${NEWBIE.email}"]`).first();
  const verifyPath = (await mail.innerText()).match(/\/verify\/[A-Za-z0-9_-]+/)![0];
  await p.goto(verifyPath);
  await p.getByRole("button", { name: "メールアドレスを確認する" }).click();
  await expect(p.getByText("メールアドレスを確認しました")).toBeVisible();
});

test("審査中の申請者は、コミュニティの中身に一切触れない", async () => {
  const p = newbiePage;
  await login(p, NEWBIE);
  await expect(p).toHaveURL("/status");
  await expect(p.getByText("（審査中）")).toBeVisible();
  for (const path of ["/", "/members", "/invites", "/admin"]) {
    await p.goto(path);
    await expect(p).toHaveURL("/status");
  }
  expect((await p.request.get(mediaUrl)).status()).toBe(404);
});

test("オーナーが承認すると、規約同意の後にフィードが見える", async () => {
  await ownerPage.goto("/admin/applications");
  const app = ownerPage.getByTestId("application").filter({ hasText: "新人 一郎" });
  await expect(app.getByText("オーナーの元同僚")).toBeVisible();
  await app.getByRole("button", { name: "承認する" }).click();
  await expect(ownerPage.getByText("承認しました。")).toBeVisible();

  const p = newbiePage;
  await p.goto("/");
  await expect(p).toHaveURL("/welcome");
  await p.getByRole("checkbox").check();
  await p.getByRole("button", { name: "同意してはじめる" }).click();
  await expect(p).toHaveURL("/");
  await expect(p.getByText("オーナーからのお知らせ")).toBeVisible();
  expect((await p.request.get(mediaUrl)).status()).toBe(200);
});

test("「友達のみ」の投稿は友達以外に見えない。コメントは通知される", async () => {
  const p = newbiePage;
  await p.getByLabel("本文").fill("友達だけに話したいこと");
  await p.getByRole("form", { name: "投稿する" }).getByText("友達のみ", { exact: true }).click();
  await expect(p.getByRole("radio", { name: "友達のみ" })).toBeChecked();
  await p.getByRole("button", { name: "投稿する" }).click();
  const secret = p.getByTestId("post").filter({ hasText: "友達だけに話したいこと" });
  await expect(secret).toBeVisible();
  const secretId = await secret.getAttribute("data-post-id");

  await ownerPage.goto("/");
  await expect(ownerPage.getByText("友達だけに話したいこと")).toHaveCount(0);
  await ownerPage.goto(`/posts/${secretId}`);
  await expect(ownerPage.getByText("ページが見つかりません")).toBeVisible();

  // 新人がオーナーの投稿にコメント → オーナーに通知
  await p.goto("/");
  const post = p.getByTestId("post").filter({ hasText: "オーナーからのお知らせ" });
  await post.getByLabel("コメントを書く").fill("よろしくお願いします！");
  await post.getByRole("button", { name: "送信" }).click();
  await expect(post.getByText("よろしくお願いします！")).toBeVisible();
  await ownerPage.goto("/notifications");
  await expect(ownerPage.getByText("新人さん さんがあなたの投稿にコメントしました")).toBeVisible();

  // メンション：入力欄には @名前 だけが見え、投稿ではプロフィールへのリンクになり、相手に通知が届く
  const composer = p.getByRole("form", { name: "投稿する" }).getByLabel("本文");
  await composer.pressSequentially("お世話になります @オー");
  await p.getByRole("option", { name: /オーナー/ }).click();
  await expect(composer).toHaveValue("お世話になります @オーナー ");
  await composer.pressSequentially("さん");
  await p.getByRole("button", { name: "投稿する" }).click();
  const mentioned = p.getByTestId("post").filter({ hasText: "お世話になります" });
  await expect(mentioned.getByRole("link", { name: "@オーナー" })).toBeVisible();
  await expect(mentioned).not.toContainText("](u:");
  await expect(composer).toHaveValue("");
  // 編集画面でも @名前 で見え、書き足して保存してもメンションは残る
  const mentionedId = await mentioned.getAttribute("data-post-id");
  await p.goto(`/posts/${mentionedId}/edit`);
  const editor = p.getByLabel("本文");
  await expect(editor).toHaveValue("お世話になります @オーナー さん");
  await editor.press("ControlOrMeta+End");
  await editor.pressSequentially("！");
  await p.getByRole("button", { name: "保存する" }).click();
  await expect(p).toHaveURL(`/posts/${mentionedId}`);
  await expect(p.getByRole("link", { name: "@オーナー" })).toBeVisible();
  await expect(p.getByText("さん！")).toBeVisible();
  await ownerPage.goto("/notifications");
  await expect(ownerPage.getByText("新人さん さんがあなたをメンションしました")).toBeVisible();
});

test("投稿の検索・1 対 1 メッセージ・イベントの出欠・ファイル添付", async () => {
  const p = newbiePage;
  // 検索：自分の投稿は見つかり、友達でない人には「友達のみ」の投稿は見つからない
  await p.goto(`/search?q=${encodeURIComponent("お世話に")}`);
  await expect(p.getByTestId("post").filter({ hasText: "お世話になります" })).toBeVisible();
  await ownerPage.goto(`/search?q=${encodeURIComponent("友達だけに")}`);
  await expect(ownerPage.getByText("を含む投稿は見つかりませんでした")).toBeVisible();

  // メッセージ：プロフィールから送り、相手の一覧に届き、開いて読める
  await p.goto("/");
  await p.getByTestId("post").filter({ hasText: "オーナーからのお知らせ" }).getByRole("link", { name: "オーナー" }).first().click();
  await expect(p).toHaveURL(/\/u\//);
  const ownerId = p.url().split("/u/")[1]!;
  await p.goto(`/messages/${ownerId}`);
  await p.getByLabel("送るメッセージ").fill("はじめまして。よろしくお願いします。");
  await p.getByRole("button", { name: "送る", exact: true }).click();
  await expect(p.getByTestId("message").filter({ hasText: "はじめまして" })).toBeVisible();
  await ownerPage.goto("/messages");
  const convo = ownerPage.getByTestId("conversation").filter({ hasText: "新人さん" });
  await expect(convo).toContainText("はじめまして");
  await convo.click();
  await expect(ownerPage.getByTestId("message").filter({ hasText: "はじめまして" })).toBeVisible();

  // イベント：オーナーが作り、新人が参加すると、オーナーに知らせが届く
  await ownerPage.goto("/events/new");
  await ownerPage.getByLabel("タイトル").fill("新人歓迎会");
  await ownerPage.getByLabel("場所（任意）").fill("本社 3F");
  await ownerPage.getByRole("button", { name: "作る" }).click();
  await expect(ownerPage.getByRole("heading", { name: "新人歓迎会" })).toBeVisible();
  await p.goto("/events");
  await p.getByTestId("event").filter({ hasText: "新人歓迎会" }).click();
  await p.getByRole("button", { name: "参加", exact: true }).click();
  await expect(p.getByTestId("attendee").filter({ hasText: "新人さん" })).toBeVisible();
  await ownerPage.goto("/notifications");
  await expect(ownerPage.getByText("新人さん さんが、イベント「新人歓迎会」に参加します")).toBeVisible();

  // ファイル添付：一時置き場に上げてから投稿し、ダウンロードとして配信される
  await p.goto("/");
  const form = p.getByRole("form", { name: "投稿する" });
  await form.getByLabel("本文").fill("資料を共有します");
  await form.getByLabel("動画・ファイルを添付").setInputFiles({ name: "議事録.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n%%EOF\n") });
  await expect(form.getByRole("list", { name: "添付" })).toContainText("MB");
  await form.getByRole("button", { name: "投稿する" }).click();
  const link = p.getByTestId("post").filter({ hasText: "資料を共有します" }).getByRole("link", { name: /議事録\.pdf/ });
  await expect(link).toBeVisible();
  const res = await p.request.get((await link.getAttribute("href"))!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-disposition"]).toContain("attachment");
});

test("承認制のグループ：投稿はメンバーにだけ見え、承認されると見えるようになる", async () => {
  await ownerPage.goto("/groups/new");
  await ownerPage.getByLabel("グループ名").fill("E2E 写真部");
  await ownerPage.getByRole("button", { name: "グループを作る" }).click();
  await expect(ownerPage.getByRole("heading", { name: "E2E 写真部" })).toBeVisible();
  const groupUrl = ownerPage.url();
  await ownerPage.getByLabel("本文").fill("グループの中だけの話");
  await ownerPage.getByRole("button", { name: "投稿する" }).click();
  await expect(ownerPage.getByText("グループの中だけの話")).toBeVisible();

  const p = newbiePage;
  await p.goto("/");
  await expect(p.getByText("グループの中だけの話")).toHaveCount(0);
  await p.goto(groupUrl);
  await p.getByRole("button", { name: "参加を申請する" }).click();
  await expect(p.getByText("承認待ちです")).toBeVisible();
  await expect(p.getByText("グループの中だけの話")).toHaveCount(0);

  await ownerPage.goto(groupUrl);
  await ownerPage.getByRole("button", { name: "承認", exact: true }).click();
  await expect(ownerPage.getByText("参加を承認しました。")).toBeVisible();

  await p.goto(groupUrl);
  await expect(p.getByText("グループの中だけの話")).toBeVisible();
  await p.goto("/");
  await expect(p.getByText("グループの中だけの話")).toBeVisible();
});

test("パスワードを忘れても、メールのリンクから再設定して入り直せる", async ({ browser }) => {
  const p = await newPage(browser);
  await p.goto("/login");
  await p.getByRole("link", { name: "パスワードを忘れた方" }).click();
  // ログイン画面にも同じ「メールアドレス」欄があるので、再設定の画面に切り替わってから入力する
  await expect(p).toHaveURL("/forgot");
  await expect(p.getByRole("heading", { name: "パスワードの再設定" })).toBeVisible();
  await p.getByLabel("メールアドレス").fill(NEWBIE.email);
  await p.getByRole("button", { name: "再設定のメールを送る" }).click();
  await expect(p.getByText("登録済みのアドレスであれば")).toBeVisible();

  await p.goto("/dev/mail");
  const mail = p.locator(`[data-testid="mail"][data-to="${NEWBIE.email}"]`).filter({ hasText: "パスワードの再設定" }).first();
  const resetPath = (await mail.innerText()).match(/\/reset\/[A-Za-z0-9_-]+/)![0];
  NEWBIE.password = "newbie-password-reset-456";
  await p.goto(resetPath);
  await p.getByLabel("新しいパスワード", { exact: true }).fill(NEWBIE.password);
  await p.getByLabel("新しいパスワード（確認）").fill(NEWBIE.password);
  await p.getByRole("button", { name: "パスワードを設定する" }).click();
  await expect(p).toHaveURL("/login?e=password_reset");

  // 再設定すると全端末からログアウトされる
  await newbiePage.goto("/");
  await expect(newbiePage).toHaveURL(/\/login/);
  await login(newbiePage, NEWBIE);
  await expect(newbiePage).toHaveURL("/");
  // 同じリンクは 2 度使えない
  await p.goto(resetPath);
  await p.getByLabel("新しいパスワード", { exact: true }).fill("another-password-789");
  await p.getByLabel("新しいパスワード（確認）").fill("another-password-789");
  await p.getByRole("button", { name: "パスワードを設定する" }).click();
  await expect(p.getByText("再設定のリンクが無効です")).toBeVisible();
  await p.context().close();
});

test("利用停止すると、次の操作から即座に締め出される", async () => {
  await ownerPage.goto("/admin/members?q=newbie");
  await ownerPage.getByRole("link", { name: "新人さん" }).click();
  await ownerPage.getByPlaceholder("停止理由（必須・監査ログに残ります）").fill("E2E テスト");
  await ownerPage.getByRole("button", { name: "利用停止にする" }).click();
  await expect(ownerPage.getByText("利用停止にしました。")).toBeVisible();

  await newbiePage.goto("/");
  await expect(newbiePage).toHaveURL(/\/login/);
  expect((await newbiePage.request.get(mediaUrl)).status()).toBe(404);

  await login(newbiePage, NEWBIE);
  await expect(newbiePage.getByText("利用停止中")).toBeVisible();

  await ownerPage.goto("/admin/audit");
  await expect(ownerPage.getByRole("cell", { name: "利用停止", exact: true })).toBeVisible();
  await expect(ownerPage.getByRole("cell", { name: "申請を承認" })).toBeVisible();
});
