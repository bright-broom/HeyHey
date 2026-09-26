/**
 * 公開範囲の 2 択。プルダウンと違い、いまの設定が常に見える。
 * ネイティブのラジオボタンなので、キーボード（矢印キー）とスクリーンリーダーでそのまま操作できる。
 */
export function VisibilityToggle({ defaultValue = "members", name = "visibility" }: { defaultValue?: string; name?: string }) {
  const options = [
    { value: "members", label: "全会員" },
    { value: "friends", label: "友達のみ" },
  ];
  return (
    <fieldset className="inline-flex border border-line-strong">
      <legend className="sr-only">公開範囲</legend>
      {options.map((o) => (
        <label key={o.value} className="relative cursor-pointer">
          <input type="radio" name={name} value={o.value} defaultChecked={defaultValue === o.value} className="peer sr-only" />
          <span className="block px-3 py-2 text-xs tracking-[0.08em] text-muted transition-colors duration-200 peer-checked:bg-ink peer-checked:text-light peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ink">
            {o.label}
          </span>
        </label>
      ))}
    </fieldset>
  );
}
