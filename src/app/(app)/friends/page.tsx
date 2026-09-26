import { PageTitle } from "@/components/PageTitle";
import Link from "next/link";
import { friendAction } from "@/app/actions/social";
import { Avatar } from "@/components/Avatar";
import { getDb } from "@/server/db/client";
import { listFriends } from "@/server/services/friends";
import { requireMember } from "@/server/web/session";

export const metadata = { title: "友達" };

type Person = { id: string; displayName: string; affiliation: string | null; avatarMediaId: string | null };

function Row({ p, children }: { p: Person; children?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-4 py-4">
      <Avatar name={p.displayName} mediaId={p.avatarMediaId} />
      <Link href={`/u/${p.id}`} className="min-w-0 flex-1">
        <p className="truncate font-medium hover:underline hover:underline-offset-4">{p.displayName}</p>
        <p className="truncate text-xs text-muted">{p.affiliation || "所属未設定"}</p>
      </Link>
      {children}
    </li>
  );
}

function Op({ userId, op, label, primary }: { userId: string; op: string; label: string; primary?: boolean }) {
  return (
    <form action={friendAction}>
      <input type="hidden" name="userId" value={userId} />
      <input type="hidden" name="op" value={op} />
      <button className={primary ? "btn-primary py-2" : "btn-ghost py-2"}>{label}</button>
    </form>
  );
}

export default async function FriendsPage() {
  const viewer = await requireMember();
  const { friends, incoming, outgoing } = await listFriends(await getDb(), viewer);
  return (
    <div className="max-w-3xl space-y-12">
      <PageTitle plaque="FRIENDS" title="友達" lead="「友達のみ」で公開された投稿は、ここにいる友達だけが見られます。" />
      {incoming.length > 0 && (
        <section className="space-y-3">
          <h2 className="h2">届いている申請（{incoming.length}）</h2>
          <ul className="divide-y divide-line border-y border-line">
            {incoming.map((p) => (
              <Row key={p.id} p={p}>
                <Op userId={p.id} op="accept" label="承認" primary />
                <Op userId={p.id} op="decline" label="見送る" />
              </Row>
            ))}
          </ul>
        </section>
      )}
      <section className="space-y-3">
        <h2 className="h2">友達（{friends.length}）</h2>
        {friends.length ? (
          <ul className="divide-y divide-line border-y border-line">
            {friends.map((p) => (
              <Row key={p.id} p={p} />
            ))}
          </ul>
        ) : (
          <p className="border-y border-line py-10 text-center text-sm text-muted">
            まだ友達がいません。<Link href="/members" className="btn-link">メンバー一覧</Link>から申請できます。
          </p>
        )}
      </section>
      {outgoing.length > 0 && (
        <section className="space-y-3">
          <h2 className="h2">申請中（{outgoing.length}）</h2>
          <ul className="divide-y divide-line border-y border-line">
            {outgoing.map((p) => (
              <Row key={p.id} p={p}>
                <Op userId={p.id} op="remove" label="取り消す" />
              </Row>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
