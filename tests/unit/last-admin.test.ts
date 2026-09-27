import { beforeAll, describe, expect, it } from "vitest";
import { and, eq, inArray, ne } from "drizzle-orm";
import type { Db } from "@/server/db/client";
import { users } from "@/server/db/schema";
import { withdraw } from "@/server/services/members";
import { db, makeUser, PASSWORD } from "./helpers";

/** 管理者が 1 人もいなくならないこと（このファイルだけで DB の管理者を 1 人にして確かめる） */
let d: Db;
beforeAll(async () => {
  d = await db();
});

describe("最後の管理者", () => {
  it("最後の管理者は退会できない。ほかに管理者を任命すれば退会できる", async () => {
    const last = await makeUser(d, { role: "admin" });
    await d.update(users).set({ role: "member" }).where(and(inArray(users.role, ["admin", "owner"]), ne(users.id, last.user.id)));
    await expect(withdraw(d, last.viewer, { password: PASSWORD, mode: "anonymize" })).rejects.toMatchObject({ code: "forbidden" });
    const next = await makeUser(d, { role: "admin" });
    await withdraw(d, last.viewer, { password: PASSWORD, mode: "anonymize" });
    expect((await d.select({ role: users.role }).from(users).where(eq(users.id, next.user.id)))[0]!.role).toBe("admin");
  });
});
