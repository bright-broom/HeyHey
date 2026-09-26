"use client";

import { useEffect, useId, useRef, useState } from "react";
import { suggestMembersAction } from "@/app/actions/content";
import { mentionToken } from "@/lib/richtext";

type Candidate = { id: string; displayName: string; affiliation: string | null };
type FieldProps = {
  name: string;
  multiline?: boolean;
  className?: string;
  placeholder?: string;
  maxLength?: number;
  rows?: number;
  required?: boolean;
  defaultValue?: string;
  "aria-label"?: string;
};

/** カーソルの直前にある「@ ＋ 検索語」（行頭か空白の直後の @ だけ）を見つける */
function findQuery(value: string, caret: number): { start: number; q: string } | null {
  const before = value.slice(0, caret);
  const m = before.match(/(^|[\s　])@([^\s　@[\]()]{0,20})$/);
  return m ? { start: caret - m[2]!.length - 1, q: m[2]! } : null;
}

/**
 * メンションできる入力欄。@ を打つと会員の候補が出て、選ぶと `@[名前](u:ID)` が入る。
 * 候補は ↑↓ で選び、Enter / Tab で確定、Esc で閉じる（スクリーンリーダー向けにコンボボックスとして振る舞う）。
 */
export function MentionField({ multiline, ...props }: FieldProps) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const listId = useId();
  const [query, setQuery] = useState<{ start: number; q: string } | null>(null);
  const [items, setItems] = useState<Candidate[]>([]);
  const [active, setActive] = useState(0);
  const open = !!query && items.length > 0;

  useEffect(() => {
    if (!query) return setItems([]);
    let cancelled = false;
    const t = setTimeout(async () => {
      const found = await suggestMembersAction(query.q);
      if (!cancelled) {
        setItems(found);
        setActive(0);
      }
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query?.q, query?.start]); // eslint-disable-line react-hooks/exhaustive-deps

  function update() {
    const el = ref.current;
    if (!el) return;
    setQuery(findQuery(el.value, el.selectionStart ?? el.value.length));
  }

  function choose(c: Candidate) {
    const el = ref.current;
    if (!el || !query) return;
    const caret = el.selectionStart ?? el.value.length;
    const token = `${mentionToken(c.displayName, c.id)} `;
    el.value = el.value.slice(0, query.start) + token + el.value.slice(caret);
    const pos = query.start + token.length;
    el.setSelectionRange(pos, pos);
    el.focus();
    setQuery(null);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (!open) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : items.length - 1)) % items.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      e.preventDefault();
      choose(items[active]!);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setQuery(null);
    }
  }

  const common = {
    ...props,
    ref,
    onInput: update,
    onClick: update,
    onKeyDown,
    onBlur: () => setTimeout(() => setQuery(null), 120),
    role: "combobox",
    "aria-autocomplete": "list" as const,
    "aria-expanded": open,
    "aria-controls": listId,
    "aria-activedescendant": open ? `${listId}-${active}` : undefined,
  };

  return (
    <div className="relative min-w-0 flex-1">
      {multiline ? <textarea {...common} /> : <input {...common} />}
      <ul id={listId} role="listbox" aria-label="メンションする会員" hidden={!open} className="absolute left-0 right-0 top-full z-30 max-h-64 overflow-y-auto border border-line bg-light shadow-lg">
        {items.map((c, i) => (
          <li
            key={c.id}
            id={`${listId}-${i}`}
            role="option"
            aria-selected={i === active}
            onMouseDown={(e) => {
              e.preventDefault();
              choose(c);
            }}
            className={`cursor-pointer px-4 py-2.5 text-sm ${i === active ? "bg-canvas" : ""}`}
          >
            {c.displayName}
            {c.affiliation && <span className="ml-2 text-xs text-muted">{c.affiliation}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}
