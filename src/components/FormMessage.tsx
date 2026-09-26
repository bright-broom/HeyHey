export function FormMessage({ state }: { state?: { error?: string; ok?: string } }) {
  if (state?.error)
    return (
      <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
        {state.error}
      </p>
    );
  if (state?.ok)
    return (
      <p role="status" className="rounded-lg bg-ok-soft px-3 py-2 text-sm text-ok">
        {state.ok}
      </p>
    );
  return null;
}
