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
  "sorry, this page isn't available",
  "this page isn't available",
  "content isn't available",
  "the link you followed may be broken",
  "к сожалению, эта страница недоступна",
  "эта страница недоступна",
  "материал недоступен",
  "профиль не найден",
  "страница удалена",
  "couldn't find this account",
  "could not find this account",
  "user not found",
  "пользователь не найден",
  "this account does not exist",
  "this account doesn't exist",
  "такого аккаунта нет",
  "не удалось найти этот аккаунт",
  "profile isn't available",
  "profile is not available",
];

export function isUserNotFoundPage(body: string): boolean {
  if (!body) return false;
  const text = body.toLowerCase();
  return NOT_FOUND_MARKERS.some(marker => text.includes(marker.toLowerCase()));
}

export function isHomeRedirect(currentUrl: string, expectedUsername: string): boolean {
  try {
    const parsed = new URL(currentUrl);
    const path = parsed.pathname.toLowerCase().replace(/\/+$/, "");
    const cleanUser = expectedUsername.toLowerCase().replace(/^@/, "");
    // Если путь /, пустой, /for_you, /following, /home, /explore:
    if (path === "" || path === "/" || path === "/for_you" || path === "/following" || path === "/home" || path === "/explore") {
      return true;
    }
    // Если путь не содержит запрашиваемый username:
    if (!path.includes(cleanUser)) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function detectBotType(ua: string): string | null {
  if (!ua) return null;
  const s = ua.toLowerCase();
  if (s.includes("googlebot") || s.includes("google-inspectiontool") || s.includes("google-site-verification")) return "Googlebot";
  if (s.includes("yandexbot") || s.includes("yandeximages") || s.includes("yandexmetrika") || s.includes("yandexwebmaster") || s.includes("yandexdirect")) return "YandexBot";
  if (s.includes("bingbot") || s.includes("msnbot") || s.includes("bingpreview")) return "Bingbot";
  if (s.includes("duckduckbot")) return "DuckDuckBot";
  if (s.includes("baiduspider")) return "Baiduspider";
  if (s.includes("ahrefsbot")) return "AhrefsBot";
  if (s.includes("semrushbot")) return "SemrushBot";
  if (s.includes("dotbot") || s.includes("mj12bot") || s.includes("bytespider") || s.includes("megaindex")) return "SEO-Crawler";
  if (s.includes("crawler") || s.includes("spider") || s.includes("headless") || s.includes("crawl") || s.includes("bot/")) return "Bot";
  return null;
}
