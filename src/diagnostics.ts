/**
 * Ежедневная самодиагностика основных функций (с pr74).
 *
 * Раз в сутки (cron 06:00 UTC = 09:00 МСК) или по кнопке в админке реально прогоняет
 * то, чем пользуются люди: загрузку постов через браузер, комментарии, HTTP-фолбэк,
 * плюс базу, Telegram и живость аккаунтов. Итог - сообщение админам в Telegram
 * и блок «Ежедневная диагностика» в админке. Цифры ошибок пользователей за 24ч - из боевой статистики.
 */
import { adminIds, type Env } from "./config";
import { Database, type SiteTruth } from "./db";
import { Telegram } from "./telegram";
import { fetchCommentsByCode, fetchProfileWithPosts, fetchPublicProfile, logSystem, type Post } from "./threads";
import { hasReplies, postCodeOf } from "./postCode";
import { trackScrape } from "./analytics";

/** Эталонный публичный профиль: существует всегда, у постов много ответов. */
export const DIAG_USERNAME = "zuck";

export type DiagStatus = "ok" | "warn" | "fail" | "skip";
export interface DiagCheck { id: string; name: string; status: DiagStatus; ms: number; detail: string }
export interface DiagReport {
  at: string;
  trigger: "cron" | "manual";
  ok: boolean;
  checks: DiagCheck[];
  /** Ошибки живых пользователей за 24ч (из боевой статистики) */
  users24h: {
    byKind: Record<string, { total: number; ok: number; failed: number; notFound: number }>;
    top: Array<{ kind: string; status: string; error: string; count: number }>;
  };
}
export interface DiagHistoryItem { at: string; ok: boolean; fails: string[]; trigger?: "cron" | "manual" }

const ICON: Record<DiagStatus, string> = { ok: "✅", warn: "⚠️", fail: "❌", skip: "⏭" };
const KIND: Record<string, string> = { profile: "профиль", more: "«загрузить ещё»", comments: "комментарии" };

/** "1,2K" / "12" / "3 тыс." -> число (для выбора поста с ответами) */
export function parseCount(v?: string | null): number {
  const s = String(v || "").replace(/\s/g, "").replace(",", ".").toLowerCase();
  const m = s.match(/^([\d.]+)(k|к|тыс\.?|m|м|млн)?/);
  if (!m) return 0;
  const n = parseFloat(m[1]) || 0;
  const mul = m[2] ? (/^(m|м|млн)/.test(m[2]) ? 1e6 : 1e3) : 1;
  return Math.round(n * mul);
}

/** Пост для проверки комментариев: есть код и есть ответы; берём тот, где ответов больше. */
export function pickPostForComments(posts: Post[]): { code: string; replies: number; post: Post } | null {
  let best: { code: string; replies: number; post: Post } | null = null;
  for (const p of posts) {
    const code = postCodeOf(p);
    if (!code || !hasReplies(p.replies)) continue;
    const replies = parseCount(p.replies);
    if (!best || replies > best.replies) best = { code, replies, post: p };
  }
  return best;
}

async function timed<T>(fn: () => Promise<T>): Promise<{ value?: T; error?: string; ms: number }> {
  const t0 = Date.now();
  try {
    return { value: await fn(), ms: Date.now() - t0 };
  } catch (e) {
    return { error: (e instanceof Error ? e.message : String(e)).slice(0, 200), ms: Date.now() - t0 };
  }
}

const sec = (ms: number) => `${(ms / 1000).toFixed(1)} с`;

export function summarizeUsers(t: Pick<SiteTruth, "scrape" | "scrapeErrorGroups">): DiagReport["users24h"] {
  const byKind: DiagReport["users24h"]["byKind"] = {};
  for (const [k, b] of Object.entries(t.scrape || {})) {
    byKind[k] = { total: b.total, ok: b.ok, failed: b.failed, notFound: b.notFound };
  }
  const top = (t.scrapeErrorGroups || [])
    .filter((g) => g.status !== "user_not_found" && g.status !== "post_not_found")
    .slice(0, 5)
    .map((g) => ({ kind: g.kind, status: g.status, error: g.error, count: g.count }));
  return { byKind, top };
}

export async function runDiagnostics(env: Env, trigger: "cron" | "manual" = "cron"): Promise<DiagReport> {
  const db = new Database(env);
  const checks: DiagCheck[] = [];
  const add = (c: DiagCheck) => { checks.push(c); };

  // 1. База данных
  {
    const r = await timed(() => env.DB.prepare("SELECT 1 AS x").first<{ x: number }>());
    add({ id: "db", name: "База данных (D1)", status: r.value?.x === 1 ? "ok" : "fail", ms: r.ms, detail: r.error || "отвечает" });
  }

  // 2. Telegram-бот
  if (env.TELEGRAM_TOKEN) {
    const r = await timed(() => new Telegram(env.TELEGRAM_TOKEN).getMe());
    add({ id: "tg", name: "Telegram-бот", status: r.value ? "ok" : "fail", ms: r.ms, detail: r.value ? `@${r.value.username || "?"} отвечает` : (r.error || "нет ответа") });
  } else {
    add({ id: "tg", name: "Telegram-бот", status: "skip", ms: 0, detail: "TELEGRAM_TOKEN не задан" });
  }

  // 3. Аккаунты-скраперы
  const counts = await db.accountCounts().catch(() => ({ total: 0, enabled: 0, alive: 0 }));
  const alive = Number(counts.alive || 0), enabled = Number(counts.enabled || 0);
  add({
    id: "accounts",
    name: "Аккаунты-скраперы",
    status: alive === 0 ? "fail" : alive < enabled ? "warn" : "ok",
    ms: 0,
    detail: `живых ${alive} из ${enabled} включённых${alive < enabled ? " - часть аккаунтов требует свежие cookies" : ""}`,
  });

  // 4. Загрузка постов через браузер (как у человека, открывшего профиль)
  let posts: Post[] = [];
  if (!env.BROWSER) {
    add({ id: "posts", name: "Загрузка постов", status: "skip", ms: 0, detail: "Browser Rendering не подключён" });
  } else if (alive === 0) {
    add({ id: "posts", name: "Загрузка постов", status: "fail", ms: 0, detail: "нет живых аккаунтов - браузерная загрузка невозможна" });
  } else {
    const r = await timed(() => fetchProfileWithPosts(env, DIAG_USERNAME, 10));
    const f = r.value;
    posts = f?.data?.posts || [];
    const viaHttp = f?.data?.source === "http";
    let status: DiagStatus, detail: string;
    if (!f || r.error) { status = "fail"; detail = `исключение: ${r.error}`; }
    else if (f.status !== "ok") { status = "fail"; detail = `${f.status}${f.error ? `: ${f.error}` : ""}`; }
    else if (viaHttp) { status = "warn"; detail = `браузер не справился, посты (${posts.length}) отдал только HTTP-фолбэк`; }
    else if (posts.length < 3) { status = "warn"; detail = `собрано всего ${posts.length} постов (ожидали 10)`; }
    else { status = "ok"; detail = `${posts.length} постов @${DIAG_USERNAME} за ${sec(r.ms)} через [${f.account || "?"}]`; }
    add({ id: "posts", name: "Загрузка постов", status, ms: r.ms, detail });
    await trackScrape(env, "diag", f?.status || "exception", posts.length, r.ms, `@${DIAG_USERNAME}`, status === "ok" ? "" : detail).catch(() => {});
  }

  // 5. Комментарии через браузер - на посте, у которого по счётчику есть ответы
  if (!env.BROWSER || alive === 0) {
    add({ id: "comments", name: "Комментарии", status: "skip", ms: 0, detail: "браузерная загрузка недоступна" });
  } else {
    const pick = pickPostForComments(posts);
    if (!pick) {
      add({ id: "comments", name: "Комментарии", status: posts.length ? "warn" : "skip", ms: 0, detail: posts.length ? "среди загруженных постов нет поста с кодом и ответами" : "посты не загрузились - проверять не на чем" });
    } else {
      const r = await timed(() => fetchCommentsByCode(env, DIAG_USERNAME, pick.code, 10));
      const f = r.value;
      const n = f?.data?.length || 0;
      let status: DiagStatus, detail: string;
      if (!f || r.error) { status = "fail"; detail = `исключение: ${r.error}`; }
      else if (f.status !== "ok") { status = "fail"; detail = `${f.status}${f.error ? `: ${f.error}` : ""}`; }
      else if (!n) { status = "fail"; detail = `у поста ${pick.post.replies} ответов по счётчику, а собрано 0 - сбор комментариев сломан`; }
      else { status = "ok"; detail = `${n} комментариев за ${sec(r.ms)} через [${f.account || "?"}] (пост ${pick.code}, по счётчику ${pick.post.replies})`; }
      add({ id: "comments", name: "Комментарии", status, ms: r.ms, detail });
      await trackScrape(env, "diag", n ? "ok" : (f?.status === "ok" ? "empty_but_replies" : (f?.status || "exception")), n, r.ms, `@${DIAG_USERNAME}/post/${pick.code}`, status === "ok" ? "" : detail).catch(() => {});
    }
  }

  // 6. HTTP-фолбэк без браузера (запасной путь, когда аккаунты не справляются)
  {
    const r = await timed(() => fetchPublicProfile(DIAG_USERNAME));
    const p = r.value;
    const status: DiagStatus = p?.exists === true ? "ok" : p?.exists === false ? "fail" : "warn";
    const detail = p?.exists === true
      ? `публичная страница отдаёт профиль${p.posts ? `, постов ${p.posts.length}` : ""}`
      : p?.exists === false ? "Threads ответил 404 на эталонный профиль" : `ответа нет${r.error ? `: ${r.error}` : p?.detail ? `: ${p.detail}` : ""} (это запасной путь, основной - браузер)`;
    add({ id: "http", name: "HTTP-фолбэк", status, ms: r.ms, detail });
  }

  // 7. Ошибки живых пользователей за 24ч
  const truth = await db.siteTruth().catch(() => null);
  const users24h = truth ? summarizeUsers(truth) : { byKind: {}, top: [] };
  {
    const parts: string[] = [];
    let worst: DiagStatus = "ok";
    for (const k of ["profile", "more", "comments"]) {
      const b = users24h.byKind[k];
      if (!b || !b.total) continue;
      parts.push(`${KIND[k]}: успешно ${b.ok} из ${b.total}${b.failed ? `, сбоев ${b.failed}` : ""}`);
      if (b.total >= 3 && b.failed / b.total > 0.5) worst = "fail";
      else if (b.failed > 0 && worst === "ok") worst = "warn";
    }
    add({ id: "users", name: "Запросы людей за 24ч", status: parts.length ? worst : "skip", ms: 0, detail: parts.join("; ") || "браузерных запросов людей не было" });
  }

  const report: DiagReport = {
    at: new Date().toISOString(),
    trigger,
    ok: !checks.some((c) => c.status === "fail"),
    checks,
    users24h,
  };

  // Сохраняем отчёт и короткую историю
  try {
    await db.setState(0, "diag_last", JSON.stringify(report));
    const history = parseHistory(await db.state(0, "diag_history"));
    history.unshift({ at: report.at, ok: report.ok, trigger, fails: checks.filter((c) => c.status === "fail").map((c) => c.name) });
    await db.setState(0, "diag_history", JSON.stringify(history.slice(0, 14)));
  } catch {}
  await logSystem(env, report.ok ? "info" : "error", "diag", `Самодиагностика (${trigger}): ${checks.map((c) => `${c.name} ${c.status}`).join(", ")}`).catch(() => {});
  return report;
}

export function parseHistory(raw: string | null): DiagHistoryItem[] {
  try {
    const v = JSON.parse(raw || "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function parseReport(raw: string | null): DiagReport | null {
  try {
    const v = JSON.parse(raw || "null");
    return v && Array.isArray(v.checks) ? v : null;
  } catch {
    return null;
  }
}

const STATUS_RU: Record<string, string> = {
  service_error: "сбой", browser_busy: "браузер занят", all_dead: "нет живых аккаунтов", session_expired: "сессия истекла",
  no_posts: "нет постов", empty_but_replies: "счётчик есть, комментариев 0", exception: "исключение",
};

function escHtml(v: unknown): string {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Текст отчёта для Telegram (HTML parse mode). */
export function formatDiagTelegram(r: DiagReport, siteUrl = "https://threadsviewer.online"): string {
  const when = new Date(r.at).toLocaleString("ru-RU", { timeZone: "Europe/Moscow", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
  const lines = [`🩺 <b>Ежедневная диагностика</b> · ${when} МСК`, r.ok ? "Всё основное работает." : "<b>Есть проблемы - см. ❌</b>", ""];
  for (const c of r.checks) lines.push(`${ICON[c.status]} <b>${escHtml(c.name)}</b>: ${escHtml(c.detail)}`);
  if (r.users24h.top.length) {
    lines.push("", "<b>Ошибки у людей за 24ч:</b>");
    for (const g of r.users24h.top) {
      lines.push(`• ${escHtml(KIND[g.kind] || g.kind)} - ${escHtml(STATUS_RU[g.status] || g.status)} ×${g.count}${g.error ? `: <i>${escHtml(g.error.slice(0, 140))}</i>` : ""}`);
    }
  }
  lines.push("", `Подробно: ${siteUrl}/admin#diag`);
  return lines.join("\n").slice(0, 3900);
}

export async function sendDiagToAdmins(env: Env, r: DiagReport): Promise<void> {
  if (!env.TELEGRAM_TOKEN) return;
  const tg = new Telegram(env.TELEGRAM_TOKEN);
  const text = formatDiagTelegram(r, env.SITE_URL || "https://threadsviewer.online");
  await Promise.all(adminIds(env).map((id) => tg.sendMessage(id, text).catch(() => {})));
}

/** Время последнего прогона ИЗ CRON (ручные запуски из админки расписание не сдвигают). */
export function lastCronAt(history: DiagHistoryItem[]): string | null {
  return history.find((h) => h.trigger !== "manual")?.at || null;
}

/** Пора ли запускать ежедневную диагностику из cron: в 06:00 UTC (09:00 МСК), либо если cron-прогона не было больше 26ч. */
export function diagDue(scheduledTime: number, lastCron: string | null): boolean {
  const last = lastCron ? new Date(lastCron).getTime() : 0;
  const since = scheduledTime - last;
  if (since < 12 * 3600_000) return false; // повторный запуск cron в том же окне не дублирует отчёт
  return new Date(scheduledTime).getUTCHours() === 6 || since > 26 * 3600_000;
}
