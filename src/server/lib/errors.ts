export type AppErrorCode = "unauthorized" | "forbidden" | "not_found" | "invalid" | "conflict" | "rate_limited";

/** 画面にそのまま出してよい日本語メッセージを持つ業務エラー。内部情報は含めない */
export class AppError extends Error {
  constructor(
    public readonly code: AppErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const forbidden = (msg = "この操作は許可されていません。") => new AppError("forbidden", msg);
export const notFound = (msg = "見つかりませんでした。") => new AppError("not_found", msg);
export const invalid = (msg: string) => new AppError("invalid", msg);
export const conflict = (msg: string) => new AppError("conflict", msg);
