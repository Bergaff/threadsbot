/**
 * Код поста Threads (например, "DAbc_12-xY") из ссылки вида
 * https://www.threads.com/@user/post/CODE или /@user/post/CODE/media.
 * По коду комментарии открываются напрямую, без поиска поста по порядковому номеру.
 */
const CODE_RE = /^[A-Za-z0-9_-]{5,40}$/;

export function isPostCode(value: unknown): value is string {
  return typeof value === "string" && CODE_RE.test(value);
}

export function postCodeFromUrl(url?: string | null): string | null {
  const m = String(url || "").match(/\/post\/([A-Za-z0-9_-]{5,40})/);
  return m ? m[1] : null;
}

/** Код поста: из postUrl, иначе из id (в JSON-пути id = code). */
export function postCodeOf(post: { postUrl?: string; id?: string } | null | undefined): string {
  if (!post) return "";
  return postCodeFromUrl(post.postUrl) || (isPostCode(post.id) ? post.id : "");
}

/** Есть ли у поста ответы по счётчику ("0", "", undefined - нет). */
export function hasReplies(replies?: string | null): boolean {
  const s = String(replies || "").trim();
  return Boolean(s) && !/^0+$/.test(s);
}
