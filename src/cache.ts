/**
 * Edge caching helper for Cloudflare Workers (caches.default).
 * Provides fast CDN caching for anonymous web traffic and search engine bots.
 */

/**
 * Ключ кеша: URL + язык из cookie. Страницы отличаются языком, а язык (кроме ?lang=) берётся из cookie,
 * поэтому без этого посетитель с lang=en мог получить русскую копию и наоборот.
 */
function edgeCacheKey(request: Request, url: URL): Request {
  const m = (request.headers.get("cookie") || "").match(/(?:^|;\s*)lang=(ru|en)/i);
  const key = new URL(url.toString());
  if (m && !key.searchParams.has("lang")) key.searchParams.set("__lang", m[1].toLowerCase());
  return new Request(key.toString(), { method: "GET" });
}

export async function matchEdgeCache(request: Request): Promise<Response | null> {
  try {
    if (typeof caches === "undefined" || !(caches as any).default) return null;
    if (request.method !== "GET") return null;

    const url = new URL(request.url);
    if (url.searchParams.get("refresh") === "1") return null;

    // Do not serve cached page to authenticated premium users
    const cookie = request.headers.get("cookie") || "";
    if (cookie.includes("threads_auth=") || url.searchParams.has("auth")) return null;

    // Honor explicit client no-cache
    const cc = request.headers.get("cache-control") || "";
    if (cc.includes("no-cache") || cc.includes("no-store")) return null;

    const cacheKey = edgeCacheKey(request, url);
    const cached = await (caches as any).default.match(cacheKey);
    if (cached) {
      const headers = new Headers(cached.headers);
      headers.set("CF-Cache-Status", "HIT");
      headers.set("X-Viewer-Cache", "HIT");
      return new Response(cached.body, {
        status: cached.status,
        statusText: cached.statusText,
        headers,
      });
    }
  } catch {
    // Fail-open: continue without edge cache
  }
  return null;
}

export function putEdgeCache(
  request: Request,
  response: Response,
  ctx?: ExecutionContext,
  ttlSeconds = 600
): void {
  try {
    if (typeof caches === "undefined" || !(caches as any).default) return;
    if (request.method !== "GET" || response.status !== 200) return;

    const url = new URL(request.url);
    if (url.searchParams.get("refresh") === "1" || url.searchParams.has("auth")) return;

    const cookie = request.headers.get("cookie") || "";
    if (cookie.includes("threads_auth=") || response.headers.has("set-cookie")) return;

    const currentCc = response.headers.get("cache-control") || "";
    if (currentCc.includes("no-cache") || currentCc.includes("no-store") || currentCc.includes("private")) {
      return;
    }

    const cloned = response.clone();
    const headers = new Headers(cloned.headers);
    if (!headers.has("cache-control")) {
      headers.set(
        "cache-control",
        `public, max-age=${ttlSeconds}, s-maxage=${ttlSeconds}, stale-while-revalidate=${ttlSeconds * 2}`
      );
    }
    headers.set("X-Viewer-Cache", "MISS");

    const toStore = new Response(cloned.body, {
      status: cloned.status,
      statusText: cloned.statusText,
      headers,
    });

    const cacheKey = edgeCacheKey(request, url);
    const putPromise = (caches as any).default.put(cacheKey, toStore).catch(() => {});
    if (ctx && typeof (ctx as any).waitUntil === "function") {
      ctx.waitUntil(putPromise);
    }
  } catch {
    // Fail-open
  }
}
