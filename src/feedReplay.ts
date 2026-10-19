/**
 * Пагинация ленты профиля повтором собственного запроса Threads (идея из goodnight000/api-anything).
 *
 * Как это работает:
 *  1. Первые посты приходят встроенными в HTML. Следующую порцию страница запрашивает сама
 *     (POST /graphql/query, тело form-urlencoded: doc_id, variables={"after": <курсор>, ...}, токены).
 *  2. Скрапер ловит такой запрос, после которого в ответе пришла лента ЭТОГО автора с page_info, и
 *     запоминает его как шаблон.
 *  3. Дальше вместо прокрутки он вызывает тот же запрос через fetch внутри открытой страницы,
 *     подставляя свежий end_cursor. Cookies и токены аккаунта браузер прикладывает сам.
 *  4. Если повтор не сработал (ошибка, нет новых постов, курсор не сдвинулся) - назад к прокрутке.
 *
 * Модуль чистый (без playwright) - покрыт юнит-тестами.
 */

export interface GraphqlTemplate {
  url: string;
  /** Только безопасные для fetch заголовки: content-type и x-* (cookie/user-agent/sec-* браузер ставит сам) */
  headers: Record<string, string>;
  body: string;
  docId: string;
  friendlyName: string;
  /** Имя переменной с курсором (обычно "after") */
  cursorKey: string;
}

export interface ReplayStats {
  attempts: number;
  ok: number;
  added: number;
  errors: string[];
  /** Повтор отключён в этом сборе (после ошибки или пустого ответа) */
  disabled: boolean;
}

export const newReplayStats = (): ReplayStats => ({ attempts: 0, ok: 0, added: 0, errors: [], disabled: false });

/** Имя запроса для журнала: заголовок x-fb-friendly-name или поле fb_api_req_friendly_name */
export function graphqlFriendlyName(headers: Record<string, string> | undefined, body: string | null | undefined): string {
  const h = headers || {};
  const fromHeader = h["x-fb-friendly-name"] || h["X-FB-Friendly-Name"];
  if (fromHeader) return String(fromHeader);
  if (body) {
    try {
      const p = new URLSearchParams(body);
      const n = p.get("fb_api_req_friendly_name");
      if (n) return n;
      const d = p.get("doc_id");
      if (d) return `doc_id=${d}`;
    } catch {}
  }
  return "?";
}

function safeHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (key === "content-type" || (key.startsWith("x-") && !key.startsWith("x-forwarded"))) out[key] = String(v);
  }
  if (!out["content-type"]) out["content-type"] = "application/x-www-form-urlencoded";
  return out;
}

/**
 * Шаблон из перехваченного запроса. null - если это не form-urlencoded GraphQL с doc_id
 * или в переменных не нашлось курсора.
 * knownCursors - курсоры, которые уже приходили в page_info (запрос просил «после» одного из них).
 */
export function templateFromRequest(
  url: string,
  headers: Record<string, string> | undefined,
  body: string | null | undefined,
  knownCursors: string[] = [],
): { template: GraphqlTemplate | null; reason: string } {
  if (!body) return { template: null, reason: "запрос без тела" };
  let params: URLSearchParams;
  try { params = new URLSearchParams(body); } catch { return { template: null, reason: "тело не form-urlencoded" }; }
  const docId = params.get("doc_id") || "";
  if (!docId) return { template: null, reason: "нет doc_id" };
  const rawVars = params.get("variables");
  if (!rawVars) return { template: null, reason: `doc_id=${docId}: нет variables` };
  let vars: any;
  try { vars = JSON.parse(rawVars); } catch { return { template: null, reason: `doc_id=${docId}: variables не JSON` }; }
  if (!vars || typeof vars !== "object") return { template: null, reason: `doc_id=${docId}: variables не объект` };
  let cursorKey = "";
  if ("after" in vars) cursorKey = "after";
  else {
    for (const [k, v] of Object.entries(vars)) {
      if (typeof v === "string" && knownCursors.includes(v)) { cursorKey = k; break; }
    }
  }
  if (!cursorKey) return { template: null, reason: `doc_id=${docId}: в variables нет курсора (ключи: ${Object.keys(vars).slice(0, 8).join(",")})` };
  return {
    template: { url, headers: safeHeaders(headers), body, docId, friendlyName: graphqlFriendlyName(headers, body), cursorKey },
    reason: "ok",
  };
}

/** Тело запроса следующей порции: тот же запрос, но курсор = cursor. null - если шаблон испорчен. */
export function buildPaginationBody(t: GraphqlTemplate, cursor: string): string | null {
  try {
    const params = new URLSearchParams(t.body);
    const vars = JSON.parse(params.get("variables") || "null");
    if (!vars || typeof vars !== "object") return null;
    vars[t.cursorKey] = cursor;
    params.set("variables", JSON.stringify(vars));
    return params.toString();
  } catch {
    return null;
  }
}

/** Краткое описание ошибки ответа для журнала (HTTP-статус, errors[] GraphQL, страница входа) */
export function describeReplayFailure(status: number, text: string): string {
  const head = (text || "").replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;\s*/, "").slice(0, 4000);
  let msg = "";
  try {
    const j = JSON.parse(head.split(/\r?\n/)[0] || "null");
    const e = Array.isArray(j?.errors) ? j.errors[0] : j?.error ? { message: j.error, code: j.error_code } : null;
    if (e) msg = `${e.message || e.summary || e.description || "ошибка"}${e.code ? ` (код ${e.code})` : ""}`;
  } catch {}
  if (!msg && /<html|login|accounts\/login/i.test(head)) msg = "вместо JSON пришла HTML-страница (вход/проверка)";
  if (!msg && status !== 200) msg = `HTTP ${status}`;
  return msg || "ответ без постов автора";
}

/** Строка для журнала про пагинацию */
export function replaySummary(t: GraphqlTemplate | null, s: ReplayStats, captureNote: string, queriesSeen: Record<string, number>): string {
  const seen = Object.entries(queriesSeen).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, c]) => `${n}×${c}`).join(", ");
  if (!t) return `пагинация запросом: шаблон не пойман (${captureNote || "сетевых запросов ленты не было"}); GraphQL-запросы страницы: ${seen || "нет"}`;
  const err = s.errors.length ? `; ошибки: ${s.errors.slice(0, 2).join(" | ")}` : "";
  return `пагинация запросом: шаблон ${t.friendlyName} (doc_id=${t.docId}, курсор "${t.cursorKey}"), повторов ${s.attempts}, успешных ${s.ok}, +${s.added} постов${s.disabled ? ", отключена -> прокрутка" : ""}${err}`;
}
