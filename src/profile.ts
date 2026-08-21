/** Threads кладёт несуществующий профиль на /login. Это не значит, что сессия мертва. */

export function isLoginUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.includes("/login") || path.includes("/accounts/login");
  } catch {
    return /\/login/i.test(url);
  }
}

const NOT_FOUND_MARKERS = [
  "page not found",
  "страница не найдена",
  "isn't available",
  "isn’t available",
  "недоступна",
  "sorry, this page isn't available",
  "this page isn't available",
  "content isn't available",
  "the link you followed may be broken",
  "user not found",
  "профиль не найден",
  "не существует",
  "couldn't find this account",
  "could not find this account",
];

export function isUserNotFoundPage(body: string): boolean {
  const text = body.toLowerCase();
  return NOT_FOUND_MARKERS.some(marker => text.includes(marker.toLowerCase()));
}
