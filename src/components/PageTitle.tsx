/** 英字の銘板＋日本語の見出し。建物の入口に掲げる表札のように、区画を静かに示す */
export function PageTitle({ plaque, title, lead, children, bare }: { plaque: string; title: string; lead?: React.ReactNode; children?: React.ReactNode; bare?: boolean }) {
  return (
    <header className={`mb-10 flex flex-wrap items-end justify-between gap-4 ${bare ? "" : "border-b border-line pb-6"}`}>
      <div>
        <p className="plaque">{plaque}</p>
        <h1 className="h1 mt-2">{title}</h1>
        {lead && <p className="mt-3 max-w-xl text-sm leading-relaxed text-muted">{lead}</p>}
      </div>
      {children}
    </header>
  );
}
