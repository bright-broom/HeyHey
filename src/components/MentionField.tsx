"use client";

import { useEffect, useId, useRef, useState } from "react";
import { suggestMembersAction } from "@/app/actions/content";
import { applyEdit, decode, encode, hasTokens, labelOf, replaceRange, type MentionSpan } from "@/lib/mention-input";
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
 * メンションできる入力欄。@ を打つと会員の候補が出て、選ぶと `@名前` が入る。
 * 候補は ↑↓ で選び、Enter / Tab で確定、Esc で閉じる（スクリーンリーダー向けにコンボボックスとして振る舞う）。
 *
 * 見える欄には `@名前` だけを出し、送るのは隠し欄の保存用の本文（`@[名前](u:ID)`）。
 * JavaScript が動くまでは、見える欄がそのまま保存用の本文を送る（書いたものを失わない）。
 * メンションの直後で Backspace（直前で Delete）を押すと、メンションをまとめて消す。
 */
export function MentionField({ multiline, name, defaultValue, ...props }: FieldProps) {
  const ref = useRef<HTMLTextAreaElement & HTMLInputElement>(null);
  const hiddenRef = useRef<HTMLInputElement>(null);
  const spans = useRef<MentionSpan[]>([]);
  const prev = useRef("");
  const [ready, setReady] = useState(false);
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

  /** 見える欄の今の文字と範囲から、送る本文を作り直す */
  function sync() {
    const el = ref.current;
    if (!el || !hiddenRef.current) return;
    hiddenRef.current.value = encode(el.value, spans.current);
    prev.current = el.value;
  }

  /** 見える欄に保存用の本文が入っているとき（初回・送信後のリセット・エラーで戻ったとき）に、見せる形へ直す */
  function normalize() {
    const el = ref.current;
    if (!el) return;
    const d = decode(el.value);
    el.value = d.text;
    spans.current = d.spans;
    sync();
  }

  useEffect(() => {
    normalize();
    setReady(true);
    const form = ref.current?.form;
    // reset イベントは値が戻る前に届くので、戻った後で直す
    const onReset = () => setTimeout(normalize, 0);
    form?.addEventListener("reset", onReset);
    return () => form?.removeEventListener("reset", onReset);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (ref.current && hasTokens(ref.current.value)) normalize();
  }, [defaultValue]); // eslint-disable-line react-hooks/exhaustive-deps

  function update() {
    const el = ref.current;
    if (!el) return;
    setQuery(findQuery(el.value, el.selectionStart ?? el.value.length));
  }

  function onInput() {
    const el = ref.current;
    if (!el) return;
    spans.current = applyEdit(prev.current, el.value, el.selectionEnd ?? el.value.length, spans.current);
    sync();
    update();
  }

  function replace(from: number, to: number, insert: string, raw?: string) {
    const el = ref.current;
    if (!el) return;
    const r = replaceRange(el.value, spans.current, from, to, insert, raw);
    el.value = r.text;
    spans.current = r.spans;
    el.setSelectionRange(r.caret, r.caret);
    sync();
  }

  function choose(c: Candidate) {
    const el = ref.current;
    if (!el || !query) return;
    const raw = mentionToken(c.displayName, c.id);
    replace(query.start, el.selectionStart ?? el.value.length, `${labelOf(raw)} `, raw);
    el.focus();
    setQuery(null);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const el = ref.current;
    if (!open && el && (e.key === "Backspace" || e.key === "Delete") && el.selectionStart === el.selectionEnd) {
      const caret = el.selectionStart ?? 0;
      const hit = spans.current.find((s) => (e.key === "Backspace" ? s.end === caret : s.start === caret));
      if (hit) {
        e.preventDefault();
        replace(hit.start, hit.end, "");
        update();
      }
      return;
    }
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
    name: ready ? undefined : name,
    defaultValue,
    onInput,
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
      <input ref={hiddenRef} type="hidden" name={ready ? name : undefined} defaultValue={defaultValue} />
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
