/**
 * pr92: бот показывает столько же постов, сколько сайт.
 *
 * Раньше у бота был свой кеш ("text") и свой сборщик (только видимые в DOM посты),
 * а сайт - кеш "web_profile" со сборщиком ленты из JSON и «загрузить ещё».
 * Из-за этого в Telegram бывало 2 поста, а на сайте 20+. Теперь:
 *  - бот берёт тот список, где постов больше (свой кеш или кеш сайта);
 *  - текстовый режим собирает посты тем же fetchProfileWithPosts, что и сайт;
 *  - результат бота дописывается в кеш сайта, не затирая шапку профиля и догруженные посты;
 *  - комментарии в боте открываются по коду поста, как на сайте.
 */
import { mergePostLists } from "./profile";
import { postCodeOf, parseCount } from "./postCode";
import type { Post } from "./threads";

/** Только посты самого автора (без чужих репостов/ответов из ленты). */
export function authorPosts(list: unknown, username: string): Post[] {
  if (!Array.isArray(list)) return [];
  const u = username.toLowerCase();
  return list.filter((p: any) => p && (!p.author || String(p.author).toLowerCase() === u)) as Post[];
}

function usableWeb(web: any): boolean {
  return Boolean(web) && !web.notFound && web.status !== "user_not_found";
}

/** Список постов для бота: где постов больше - свой кеш или кеш сайта. null - кеша нет. */
export function pickBotPosts(own: Post[] | null | undefined, web: any, username: string): Post[] | null {
  const mine = authorPosts(own, username);
  const site = usableWeb(web) ? authorPosts(web.posts, username) : [];
  if (site.length > mine.length) return site;
  return mine.length ? mine : null;
}

/**
 * Свежий результат бота + то, что уже лежит в кеше сайта.
 * Свежие посты идут первыми, более старые догруженные на сайте сохраняются в хвосте.
 * Шапка профиля (аватар, био) не затирается заглушкой.
 */
export function mergeIntoWebProfile(existing: any, fresh: { profile?: any; posts?: Post[]; endReached?: boolean; [k: string]: any }, username: string): any {
  const prev = usableWeb(existing) ? existing : null;
  const freshPosts = authorPosts(fresh.posts, username);
  const prevPosts = prev ? authorPosts(prev.posts, username) : [];
  const posts = freshPosts.length ? mergePostLists(freshPosts, prevPosts) : prevPosts;
  const freshProfile = fresh.profile && (fresh.profile.avatar || fresh.profile.bio || fresh.profile.followers) ? fresh.profile : null;
  const out: any = {
    ...(prev || {}),
    ...fresh,
    profile: freshProfile || prev?.profile || fresh.profile || null,
    posts,
  };
  delete out.endReached;
  delete out.exhaustedAt;
  if (fresh.endReached === true && posts.length === freshPosts.length) out.endReachedAt = posts.length;
  else if (posts.length !== freshPosts.length) delete out.endReachedAt;
  return out;
}

/** Код поста и число ответов по счётчику для номера n (1..N) в списке бота. */
export function postRefByNumber(posts: Post[] | null | undefined, n: number): { code: string; expected: number } | null {
  if (!Array.isArray(posts) || !Number.isInteger(n) || n < 1 || n > posts.length) return null;
  const p: any = posts[n - 1];
  const code = postCodeOf(p);
  if (!code) return null;
  return { code, expected: parseCount(p.replies) };
}
