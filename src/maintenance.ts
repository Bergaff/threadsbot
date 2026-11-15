/**
 * Заглушка «технические неполадки» (pr87).
 *
 * Когда cookies ВСЕХ включённых аккаунтов Threads перестали работать (is_alive=0 у каждого), сайт
 * не может показать ни профили, ни комментарии. Вместо череды ошибок посетители видят заглушку
 * «Технические неполадки, просим подождать», а админы получают сообщение в Telegram.
 * Как только загружены свежие cookies (аккаунт снова is_alive=1), сайт сам возвращается к работе,
 * и админам приходит «Сайт снова работает».
 *
 * Режим можно переопределить из админки: auto (по аккаунтам) / on (принудительно) / off (никогда).
 */
import { adminIds, type Env } from "./config";
import { Telegram } from "./telegram";

export type MaintenanceMode = "auto" | "on" | "off";

export interface MaintenanceState {
  on: boolean;
  mode: MaintenanceMode;
  /** Включённых аккаунтов / живых среди них */
  enabled: number;
  alive: number;
  /** С какого момента включена заглушка (ISO), если включена */
  since: string | null;
}

const MEMO_MS = 30_000;
/** Кэш состояния на 30 с в пределах изолята; ключ - объект базы (в тестах у каждого окружения свой) */
const memo = new WeakMap<object, { at: number; st: MaintenanceState }>();

export function forgetMaintenance(env: Env): void {
  if (env.DB) memo.delete(env.DB as unknown as object);
}

const OFF: MaintenanceState = { on: false, mode: "auto", enabled: 0, alive: 0, since: null };

async function readState(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM bot_state WHERE scope=? AND state_key=?").bind("system", key).first<{ value: string }>();
  return row?.value ?? null;
}

function writeState(env: Env, key: string, value: string) {
  return env.DB.prepare(
    "INSERT INTO bot_state(scope,state_key,value,updated_at) VALUES(?,?,?,?) ON CONFLICT(scope,state_key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at"
  ).bind("system", key, value, new Date().toISOString()).run();
}

export function parseMode(v: unknown): MaintenanceMode {
  return v === "on" || v === "off" ? v : "auto";
}

/** Решение без базы: включать ли заглушку */
export function decideMaintenance(mode: MaintenanceMode, enabled: number, alive: number): boolean {
  if (mode === "on") return true;
  if (mode === "off") return false;
  // Аккаунты есть, но ни один не жив. Пустая таблица (аккаунтов не заводили) - не заглушка.
  return enabled > 0 && alive <= 0;
}

/**
 * Текущее состояние. Раз в 30 с (или при fresh) перечитывает базу и, если состояние сменилось,
 * запоминает это и пишет админам в Telegram. Ошибка базы - заглушку не включаем (сайт важнее).
 * defer - ctx.waitUntil, чтобы отправка в Telegram не задерживала ответ посетителю.
 */
export async function getMaintenance(env: Env, opts: { fresh?: boolean; defer?: (p: Promise<unknown>) => void } = {}): Promise<MaintenanceState> {
  if (!env.DB || typeof env.DB.prepare !== "function") return OFF;
  const key = env.DB as unknown as object;
  const hit = memo.get(key);
  if (!opts.fresh && hit && Date.now() - hit.at < MEMO_MS) return hit.st;
  let st: MaintenanceState;
  let stored: string | null = null;
  try {
    const [counts, modeRaw, storedRaw] = await Promise.all([
      env.DB.prepare("SELECT SUM(enabled) enabled, SUM(enabled AND is_alive) alive FROM threads_accounts").first<{ enabled: number; alive: number }>(),
      readState(env, "maintenance_mode"),
      readState(env, "maintenance_state"),
    ]);
    stored = storedRaw;
    const mode = parseMode(modeRaw);
    const enabled = Number(counts?.enabled || 0);
    const alive = Number(counts?.alive || 0);
    const on = decideMaintenance(mode, enabled, alive);
    const prevOn = Boolean(stored && stored.startsWith("on"));
    const prevSince = prevOn ? stored!.slice(3) || null : null;
    st = { on, mode, enabled, alive, since: on ? (prevOn ? prevSince : new Date().toISOString()) : null };
  } catch {
    return hit?.st || OFF;
  }
  memo.set(key, { at: Date.now(), st });
  const prevOn = Boolean(stored && stored.startsWith("on"));
  if (stored === null || prevOn !== st.on) {
    const job = recordTransition(env, stored, st).catch(() => {});
    if (opts.defer) opts.defer(job); else await job;
  }
  return st;
}

/** Синхронизация после событий с аккаунтами (смерть сессии, загрузка cookies, сброс статусов, cron) */
export function syncMaintenance(env: Env): Promise<MaintenanceState> {
  return getMaintenance(env, { fresh: true });
}

async function recordTransition(env: Env, prev: string | null, st: MaintenanceState): Promise<void> {
  const value = st.on ? `on|${st.since || new Date().toISOString()}` : `off|${new Date().toISOString()}`;
  if (prev === null) {
    // Первая запись (после деплоя): молча запоминаем, сообщаем только если сайт уже на заглушке
    await writeState(env, "maintenance_state", value);
    if (!st.on) return;
  } else {
    // Атомарно: сообщение отправит только тот сервер, который первым сменил состояние
    const r: any = await env.DB.prepare("UPDATE bot_state SET value=?,updated_at=? WHERE scope='system' AND state_key='maintenance_state' AND value=?")
      .bind(value, new Date().toISOString(), prev).run();
    const changes = r?.meta?.changes;
    if (typeof changes === "number" && changes === 0) return;
  }
  await notifyAdmins(env, maintenanceMessage(st, prev));
}

const msk = (iso: string | null) => {
  if (!iso) return "?";
  try { return new Date(iso).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) + " МСК"; } catch { return iso; }
};

export function maintenanceMessage(st: MaintenanceState, prev: string | null): string {
  if (st.on) {
    const why = st.mode === "on"
      ? "Заглушка включена вручную в админке."
      : `У всех аккаунтов Threads перестали работать cookies (живых 0 из ${st.enabled}).`;
    return `🛠 <b>Сайт переведён на заглушку</b>\n\n${why}\nПосетители видят «Технические неполадки, просим подождать», бот отвечает так же.\n\n` +
      (st.mode === "on"
        ? "Снять: админка → «Заглушка» → «Авто» или «Выключить»."
        : "Загрузите свежие cookies в админке (/admin → Аккаунты) или боту - сайт вернётся к работе сам, я напишу.");
  }
  const since = prev && prev.startsWith("on|") ? prev.slice(3) : null;
  const mins = since ? Math.max(0, Math.round((Date.now() - new Date(since).getTime()) / 60_000)) : null;
  const why = st.mode === "off" ? "Заглушка выключена вручную в админке." : `Живых аккаунтов: ${st.alive} из ${st.enabled}.`;
  return `✅ <b>Сайт снова работает</b>\n\n${why}` + (since ? `\nЗаглушка висела с ${msk(since)}${mins != null ? ` (${mins} мин)` : ""}.` : "");
}

async function notifyAdmins(env: Env, text: string): Promise<void> {
  if (!env.TELEGRAM_TOKEN) return;
  const tg = new Telegram(env.TELEGRAM_TOKEN);
  await Promise.all(adminIds(env).map((id) => tg.sendMessage(id, text).catch(() => {})));
}

/** Режим из админки */
export async function setMaintenanceMode(env: Env, mode: MaintenanceMode): Promise<MaintenanceState> {
  await writeState(env, "maintenance_mode", mode);
  return syncMaintenance(env);
}

/** Пути, которые без живых аккаунтов не работают: главная (поиск), профили, посты и их API */
export function isMaintenanceGated(path: string): boolean {
  return (
    path === "/" || path === "/index.html" || path === "/en" || path === "/en/" ||
    /^\/(?:@|profile\/|user\/|u\/)[A-Za-z0-9._]+(?:\/post\/[A-Za-z0-9._-]+)?\/?$/.test(path) ||
    /^\/[A-Za-z0-9._]+\/post\/[A-Za-z0-9._-]+\/?$/.test(path) ||
    path.startsWith("/api/profile/") || path.startsWith("/api/comments/")
  );
}

export const MAINTENANCE_TEXT = {
  ru: {
    title: "Технические неполадки",
    body: "Сейчас на сайте технические неполадки. Мы уже чиним - пожалуйста, подождите немного. Страница обновится сама, когда всё заработает.",
    api: "Технические неполадки. Пожалуйста, подождите - скоро всё заработает.",
  },
  en: {
    title: "Technical difficulties",
    body: "We are experiencing technical difficulties and are already fixing them. Please wait a little - this page will reload by itself once everything works again.",
    api: "Technical difficulties. Please wait - we will be back shortly.",
  },
};

const noStore = { "cache-control": "no-store, max-age=0", "retry-after": "600", "x-maintenance": "1" };

export function maintenanceApiResponse(lang: "ru" | "en" = "ru"): Response {
  return Response.json(
    { ok: false, status: "maintenance", maintenance: true, error: MAINTENANCE_TEXT[lang].api, retryAfter: 120 },
    { status: 503, headers: noStore },
  );
}

/** Страница-заглушка: 503 + Retry-After (поисковики не выкидывают страницы из индекса), сама перепроверяет раз в минуту */
export function renderMaintenancePage(lang: "ru" | "en" = "ru", opts: { isAdmin?: boolean; bypassUrl?: string } = {}): Response {
  const t = MAINTENANCE_TEXT[lang];
  const admin = opts.isAdmin
    ? `<p class="adm">${lang === "en" ? "You are an admin." : "Вы вошли как админ."} <a href="/admin">${lang === "en" ? "Admin panel" : "Админка"}</a>${opts.bypassUrl ? ` · <a href="${opts.bypassUrl}">${lang === "en" ? "Open the site anyway" : "Открыть сайт в обход заглушки"}</a>` : ""}</p>`
    : "";
  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${t.title} · Threads Viewer</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
  html,body{margin:0;height:100%;background:#0b0b0c;color:#e8e8ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif}
  .wrap{min-height:100%;display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
  .card{max-width:480px;text-align:center;border:1px solid #2a2a2e;border-radius:14px;padding:32px 24px;background:#141416}
  .icon{font-size:44px;line-height:1;margin-bottom:12px}
  h1{font-size:1.35rem;margin:0 0 12px}
  p{color:#a8a8ad;line-height:1.55;margin:0 0 10px}
  .muted{font-size:.82rem;color:#77777c}
  .adm{font-size:.82rem;margin-top:16px}
  a{color:#8ab4ff}
  button{margin-top:14px;background:#e8e8ea;color:#0b0b0c;border:0;border-radius:8px;padding:9px 18px;font-size:.9rem;cursor:pointer}
</style>
</head>
<body>
<div class="wrap"><div class="card">
  <div class="icon">🛠</div>
  <h1>${t.title}</h1>
  <p>${t.body}</p>
  <p class="muted">Threads Viewer</p>
  <button type="button" onclick="location.reload()">${lang === "en" ? "Refresh" : "Обновить"}</button>
  ${admin}
</div></div>
<script>
  // Раз в минуту проверяем, снята ли заглушка, и если да - перезагружаем страницу
  setInterval(function () {
    fetch("/api/maintenance", { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) {
      if (d && d.ok && !d.on) location.reload();
    }).catch(function () {});
  }, 60000);
</script>
</body>
</html>`;
  return new Response(html, { status: 503, headers: { "content-type": "text/html; charset=UTF-8", ...noStore } });
}
