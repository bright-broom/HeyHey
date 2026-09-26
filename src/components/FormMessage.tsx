export function FormMessage({ state }: { state?: { error?: string; ok?: string } }) {
  if (state?.error)
    return (
      <p role="alert" className="border-l-2 border-danger py-1 pl-3 text-sm text-danger">
        {state.error}
      </p>
    );
  if (state?.ok)
    return (
      <p role="status" className="border-l-2 border-ok py-1 pl-3 text-sm text-ok">
        {state.ok}
      </p>
    );
  return null;
}
