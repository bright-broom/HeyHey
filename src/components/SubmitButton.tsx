"use client";

import { useFormStatus } from "react-dom";

export function SubmitButton({
  children,
  className = "btn-primary",
  pendingText,
  name,
  value,
  disabled,
  ...rest
}: {
  children: React.ReactNode;
  className?: string;
  pendingText?: string;
  name?: string;
  value?: string;
} & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending || disabled} name={name} value={value} {...rest}>
      {pending ? (pendingText ?? "送信中…") : children}
    </button>
  );
}
