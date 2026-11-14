/**
 * Сбор ленты профиля из СЕТЕВЫХ ответов Threads (GraphQL) и предзагруженного JSON.
 *
 * Зачем: при прокрутке профиля Threads догружает посты запросами /graphql/query.
 * В каждом ответе лежат сами посты (код, текст, медиа, лайки) и page_info.has_next_page -
 * ЕДИНСТВЕННЫЙ достоверный признак того, что лента автора действительно закончилась.
 * Парсинг DOM такого признака не даёт: «новые карточки не появились» может означать
 * и конец ленты, и просто медленную подгрузку.
 *
 * Модуль чистый (без playwright), поэтому покрыт юнит-тестами.
 */

import { newReplayStats, type GraphqlTemplate, type ReplayStats } from "./feedReplay";

export interface FeedPost {
  id?: string;
  text: string;
  has_image: boolean;
  has_video: boolean;
  videoUrl?: string;
  imageUrl?: string;
  images?: string[];
  postUrl?: string;
  likes?: string;
  replies?: string;
  date?: string;
  author?: string;
  authorAvatar?: string;
}

/** Тело ответа Meta может начинаться с for (;;); и содержать несколько JSON подряд (стриминг). */
export function parseThreadsPayload(text: string): any[] {
  const out: any[] = [];
  if (!text) return out;
  const body = text.replace(/^\s*for\s*\(\s*;\s*;\s*\)\s*;\s*/, "").trim();
  if (!body) return out;
  try {
    out.push(JSON.parse(body));
    return out;
  } catch {
    // несколько JSON-документов, разделённых переводами строк
  }
  for (const line of body.split(/\r?\n/)) {
    const l = line.trim();
    if (!l || (l[0] !== "{" && l[0] !== "[")) continue;
    try { out.push(JSON.parse(l)); } catch { /* skip */ }
  }
  return out;
}

function formatDate(ts: unknown): string | undefined {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return undefined;
  const d = new Date(ts < 1e11 ? ts * 1000 : ts);
  if (Number.isNaN(d.getTime())) return undefined;
  // Тот же формат, что у DOM-парсера: 2026-09-15 23:01
  return d.toISOString().replace("T", " ").slice(0, 16);
}

/**
 * Время поста в мс из поля date: "2026-09-15 23:01" (UTC, формат DOM/JSON-парсеров),
 * полный ISO ("2026-09-15T23:01:39.000Z") или число секунд/мс. Нет даты - NaN.
 */
export function postTimeMs(date?: string | number | null, now = Date.now()): number {
  if (typeof date === "number") return Number.isFinite(date) && date > 0 ? (date < 1e11 ? date * 1000 : date) : NaN;
  const s = String(date || "").trim();
  if (!s) return NaN;
  if (/^\d{9,13}$/.test(s)) return postTimeMs(Number(s));
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (m && !/[+-]\d{2}:?\d{2}$|Z$/i.test(s)) return Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
  // Относительная дата из текста DOM, если нет атрибута datetime: "2h", "5d", "3 дн.", "10 мин"
  const r = s.toLowerCase().match(/^(\d+)\s*(s|sec|с|сек|m|min|мин|h|hr|ч|d|д|дн|w|нед|н|y|г)\.?/);
  if (r) {
    const unit: Record<string, number> = { s: 1, sec: 1, "с": 1, "сек": 1, m: 60, min: 60, "мин": 60, h: 3600, hr: 3600, "ч": 3600, d: 86400, "д": 86400, "дн": 86400, w: 604800, "нед": 604800, "н": 604800, y: 31536000, "г": 31536000 };
    return now - Number(r[1]) * (unit[r[2]] || 0) * 1000;
  }
  // Прочее парсим, только если есть год: иначе Date.parse("Sep 15") даёт 2001 год
  if (!/\b\d{4}\b/.test(s)) return NaN;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : NaN;
}

/**
 * Посты от свежего к старому (pr86). Threads отдаёт ленту с закреплёнными постами сверху, а склейка DOM
 * и сетевого JSON дописывает найденные только в сети посты в конец - из-за этого лента шла вразнобой.
 * Сортировка устойчивая; посту без даты достаётся время соседа сверху, чтобы он остался на своём месте.
 */
export function sortPostsNewestFirst<T extends { date?: string }>(posts: T[]): T[] {
  const keys: number[] = new Array(posts.length);
  let prev = Infinity;
  for (let i = 0; i < posts.length; i++) {
    const t = postTimeMs(posts[i]?.date);
    if (Number.isFinite(t)) prev = t;
    keys[i] = Number.isFinite(t) ? t : prev;
  }
  return posts
    .map((p, i) => ({ p, i, k: keys[i] }))
    .sort((a, b) => (b.k === a.k ? a.i - b.i : b.k > a.k ? 1 : -1))
    .map((x) => x.p);
}

function bestCandidate(iv: any): string {
  const list = iv?.candidates;
  if (!Array.isArray(list) || !list.length) return "";
  let best = list[0];
  for (const c of list) {
    if ((c?.width || 0) > (best?.width || 0)) best = c;
  }
  return typeof best?.url === "string" ? best.url : "";
}

/** Похоже ли значение на объект поста Threads (Barcelona post). */
function isThreadsPost(node: any): boolean {
  return Boolean(
    node && typeof node === "object" &&
    typeof node.code === "string" && node.code &&
    node.user && typeof node.user.username === "string" &&
    ("caption" in node || "text_post_app_info" in node || "taken_at" in node)
  );
}

export function normalizeThreadsPost(node: any): FeedPost | null {
  if (!isThreadsPost(node)) return null;
  let text = typeof node.caption?.text === "string" ? node.caption.text : "";
  if (!text) {
    const frags = node.text_post_app_info?.text_fragments?.fragments;
    if (Array.isArray(frags)) text = frags.map((f: any) => (typeof f?.plaintext === "string" ? f.plaintext : "")).join("");
  }
  text = String(text || "").trim();

  const images: string[] = [];
  let videoUrl = "";
  const carousel = Array.isArray(node.carousel_media) ? node.carousel_media : [];
  for (const m of carousel) {
    const img = bestCandidate(m?.image_versions2);
    if (img && !images.includes(img)) images.push(img);
    if (!videoUrl && Array.isArray(m?.video_versions) && m.video_versions[0]?.url) videoUrl = m.video_versions[0].url;
  }
  if (!carousel.length) {
    const img = bestCandidate(node.image_versions2);
    if (img) images.push(img);
  }
  if (!videoUrl && Array.isArray(node.video_versions) && node.video_versions[0]?.url) videoUrl = node.video_versions[0].url;

  // Аватар-заглушка (поле image_versions2 бывает у чисто текстовых постов с пустыми кандидатами)
  const hasVideo = Boolean(videoUrl);
  const hasImage = images.length > 0;
  if (!text && !hasImage && !hasVideo) return null;

  const author = String(node.user.username).toLowerCase();
  const likeRaw = node.like_count;
  const replyRaw = node.text_post_app_info?.direct_reply_count ?? node.comment_count;

  return {
    id: String(node.code),
    text,
    has_image: hasImage,
    has_video: hasVideo,
    videoUrl: videoUrl || undefined,
    imageUrl: images[0],
    images: images.length ? images : undefined,
    postUrl: `/@${author}/post/${node.code}`,
    likes: typeof likeRaw === "number" || typeof likeRaw === "string" ? String(likeRaw) : undefined,
    replies: typeof replyRaw === "number" || typeof replyRaw === "string" ? String(replyRaw) : undefined,
    date: formatDate(node.taken_at),
    author,
    authorAvatar: typeof node.user.profile_pic_url === "string" ? node.user.profile_pic_url : undefined,
  };
}

/** Код поста из ссылки вида /@user/post/CODE или https://www.threads.com/@user/post/CODE */
export function postCodeFromUrl(url?: string): string {
  if (!url) return "";
  const m = url.match(/\/post\/([A-Za-z0-9_-]+)/);
  return m ? m[1] : "";
}

/**
 * Накопитель ленты конкретного автора. Принимает любые JSON-ответы Threads,
 * вытаскивает из них посты автора (в порядке ленты) и последний page_info его ленты.
 */
export class FeedCollector {
  readonly username: string;
  readonly posts: FeedPost[] = [];
  private codes = new Set<string>();
  /** null - Threads ещё не сообщил; false - лента автора достоверно закончилась. */
  hasNextPage: boolean | null = null;
  endCursor: string | null = null;
  responses = 0;
  /** Диагностика прокрутки, если лента не догрузилась до цели (заполняет скрапер) */
  scrollDiag = "";
  /** Сколько раз приходил page_info ленты этого автора (по нему узнаём «тот самый» запрос) */
  pageInfoUpdates = 0;
  /** Все курсоры ленты автора по порядку */
  readonly cursors: string[] = [];
  /** Перехваченный запрос следующей порции (см. feedReplay.ts) */
  template: GraphqlTemplate | null = null;
  /** Почему шаблон не пойман (для журнала) */
  captureNote = "";
  /** Какие GraphQL-запросы делала страница: имя -> количество */
  readonly queriesSeen: Record<string, number> = {};
  readonly replay: ReplayStats = newReplayStats();
  /** Тела наших повторных запросов - их ответы разбирает сам повтор, а не перехватчик */
  readonly replayBodies = new Set<string>();

  constructor(username: string) {
    this.username = username.toLowerCase().replace(/^@/, "");
  }

  ingestText(text: string): number {
    let added = 0;
    for (const doc of parseThreadsPayload(text)) added += this.ingestJson(doc);
    return added;
  }

  ingestJson(root: any): number {
    const before = this.posts.length;
    this.responses++;
    this.walk(root, 0);
    return this.posts.length - before;
  }

  private addPost(node: any): boolean {
    const p = normalizeThreadsPost(node);
    if (!p || p.author !== this.username || !p.id) return false;
    if (this.codes.has(p.id)) return false;
    this.codes.add(p.id);
    this.posts.push(p);
    return true;
  }

  /** Посты из thread_items одного edge. true - в нём был хотя бы один пост автора. */
  private takeThreadItems(items: any[]): boolean {
    let mine = false;
    for (const it of items) {
      const post = it?.post;
      if (isThreadsPost(post) && String(post.user.username).toLowerCase() === this.username) {
        mine = true;
        this.addPost(post);
      }
    }
    return mine;
  }

  private walk(node: any, depth: number): void {
    if (!node || typeof node !== "object" || depth > 40) return;
    if (Array.isArray(node)) {
      for (const x of node) this.walk(x, depth + 1);
      return;
    }

    // Соединение ленты: { edges: [{ node: { thread_items: [...] } }], page_info: {...} }
    if (Array.isArray(node.edges) && node.page_info && typeof node.page_info === "object") {
      let mine = false;
      for (const e of node.edges) {
        const items = e?.node?.thread_items;
        if (Array.isArray(items) && this.takeThreadItems(items)) mine = true;
      }
      // page_info учитываем только у ленты ЭТОГО автора, а не у рекомендаций/ответов
      if (mine && typeof node.page_info.has_next_page === "boolean") {
        this.hasNextPage = node.page_info.has_next_page;
        this.pageInfoUpdates++;
        const cur = node.page_info.end_cursor;
        if (typeof cur === "string") {
          this.endCursor = cur;
          if (!this.cursors.includes(cur)) this.cursors.push(cur);
        }
      }
    } else if (Array.isArray(node.thread_items)) {
      this.takeThreadItems(node.thread_items);
    }

    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") this.walk(v, depth + 1);
    }
  }
}

/**
 * Объединяет посты, считанные из DOM, с постами из сети.
 * Порядок DOM сохраняется (так их видит пользователь), сетевые данные дополняют
 * карточки точными медиа/лайками, а посты, которых DOM-парсер не увидел, дописываются в конец.
 */
export function mergeDomWithFeed<T extends FeedPost>(dom: T[], feed: FeedPost[]): T[] {
  const byCode = new Map<string, FeedPost>();
  const byText = new Map<string, FeedPost>();
  for (const p of feed) {
    if (p.id) byCode.set(p.id, p);
    if (p.text) byText.set(p.text.slice(0, 60), p);
  }
  const used = new Set<string>();
  const out: T[] = [];
  for (const d of dom) {
    const code = postCodeFromUrl(d.postUrl);
    const net = (code && byCode.get(code)) || (d.text ? byText.get(d.text.slice(0, 60)) : undefined);
    if (net && net.id) {
      if (used.has(net.id)) continue; // DOM дважды увидел один и тот же пост
      used.add(net.id);
      out.push({
        ...d,
        id: d.id || net.id,
        postUrl: d.postUrl || net.postUrl,
        likes: d.likes || net.likes,
        replies: d.replies || net.replies,
        date: d.date || net.date,
        videoUrl: net.videoUrl || d.videoUrl,
        has_video: d.has_video || net.has_video,
        imageUrl: d.imageUrl || net.imageUrl,
        images: d.images && d.images.length ? d.images : net.images,
        has_image: d.has_image || net.has_image,
        authorAvatar: d.authorAvatar || net.authorAvatar,
      });
    } else {
      out.push(d);
    }
  }
  for (const p of feed) {
    if (p.id && used.has(p.id)) continue;
    out.push({ ...(p as T) });
  }
  return out;
}

/** Ответ (комментарий) на пост, собранный из JSON страницы поста. */
export interface FeedReply { code: string; author: string; text: string; avatar?: string; likes?: string }

/**
 * Сбор комментариев со страницы поста из JSON (предзагрузка + GraphQL при прокрутке), с pr76.
 *
 * Зачем: DOM-парсер комментариев зависит от вёрстки Threads и на части постов собирал 0,
 * хотя счётчик показывал ответы. В JSON страницы поста лежат edges -> thread_items:
 *  - цепочка самого поста (предки + пост с кодом mainCode),
 *  - ветки ответов; у ответа text_post_app_info.reply_to_author заполнен, у поста верхнего уровня - null.
 * Модуль чистый, покрыт юнит-тестами.
 */
export class ReplyCollector {
  readonly mainCode: string;
  readonly replies: FeedReply[] = [];
  /** Встречался ли сам пост в JSON (для диагностики) */
  mainSeen = false;
  responses = 0;
  /** Сетевых ответов, где вообще встречается код поста / thread_items (диагностика) */
  textsWithMain = 0;
  textsWithThreads = 0;
  /** Постов в thread_items (кроме самого поста), отброшенных как «не ответ» / недоступных */
  droppedTopLevel: FeedReply[] = [];
  droppedUnavailable = 0;
  /**
   * Ответы, найденные ВНЕ thread_items (любой объект-пост с reply_to_author). Запасной путь на случай,
   * если Threads отдаёт страницу поста в другой форме: по логам на ~5% постов в JSON не было ни
   * thread_items, ни кода поста, и строгий разбор собирал 0.
   */
  loose: FeedReply[] = [];
  /** Сам пост встречался где угодно в JSON (не только в thread_items) */
  mainSeenAnywhere = false;
  /** Откуда приходили ответы сети: путь -> количество (диагностика) */
  readonly endpoints: Record<string, number> = {};
  /**
   * Форма данных (диагностика, pr86): все объекты-посты где угодно в JSON, кроме самого поста, -
   * сколько с reply_to_author (ответ), с null (верхний уровень), без поля; где лежат (путь ключей); ключи примера.
   */
  readonly shapeCounts = { posts: 0, replyTo: 0, nullTo: 0, noField: 0, noInfo: 0 };
  readonly shapePaths: Record<string, number> = {};
  shapeSample = "";
  private shapeSeen = new Set<string>();
  /** Образцы ответов сети/встроенного JSON для разбора новой формы данных (самые информативные) */
  readonly samples: Array<{ src: string; score: number; text: string }> = [];
  /**
   * Третий, самый мягкий запасной путь (pr86): посты вне thread_items, у которых в text_post_app_info
   * НЕТ поля reply_to_author (неизвестная форма), найденные в том же JSON-документе, где есть сам пост.
   * Посты с reply_to_author = null (верхний уровень, рекомендации) сюда не попадают.
   */
  soft: FeedReply[] = [];
  private softCodes = new Set<string>();
  private curHasMain = false;
  private looseCodes = new Set<string>();
  /** Коды постов, уже разобранных строгим путём (thread_items) - в запасной список их не берём */
  private threadCodes = new Set<string>();
  private codes = new Set<string>();
  private droppedCodes = new Set<string>();
  private ancestors = new Set<string>();
  private readonly mainAuthor: string;

  constructor(mainCode: string, mainAuthor = "") {
    this.mainCode = mainCode;
    this.mainAuthor = mainAuthor.toLowerCase().replace(/^@/, "");
  }

  ingestText(text: string, src = "net"): number {
    const hasMain = text.includes(this.mainCode);
    if (hasMain) this.textsWithMain++;
    if (text.includes("thread_items")) this.textsWithThreads++;
    this.keepSample(text, src, hasMain);
    let added = 0;
    for (const doc of parseThreadsPayload(text)) added += this.ingestJson(doc, hasMain);
    return added;
  }

  /** Держим до 4 самых информативных текстов (с кодом поста / reply_to_author / thread_items), по 60 КБ */
  private keepSample(text: string, src: string, hasMain: boolean): void {
    const score = (hasMain ? 4 : 0) + (text.includes("reply_to_author") ? 2 : 0) + (text.includes("thread_items") ? 1 : 0) + (text.includes('"code"') ? 1 : 0);
    if (!score) return;
    const cut = text.length > 60_000 ? text.slice(0, 60_000) + `…[обрезано, всего ${text.length} симв.]` : text;
    if (this.samples.some((s) => s.text === cut)) return;
    this.samples.push({ src, score, text: cut });
    this.samples.sort((a, b) => b.score - a.score);
    if (this.samples.length > 4) this.samples.length = 4;
  }

  /** Сводка формы данных для диагностики */
  shape(): string {
    const c = this.shapeCounts;
    const paths = Object.entries(this.shapePaths).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k}×${v}`).join(", ");
    return `JSON-постов кроме самого ${c.posts} (с reply_to_author ${c.replyTo}, с null ${c.nullTo}, без поля ${c.noField}, без text_post_app_info ${c.noInfo})${paths ? `; где: ${paths}` : ""}${this.shapeSample ? `; пример: ${this.shapeSample}` : ""}`;
  }

  private noteShape(node: any, path: string[]): void {
    const code = String(node.code);
    if (code === this.mainCode || this.shapeSeen.has(code)) return;
    this.shapeSeen.add(code);
    const c = this.shapeCounts;
    c.posts++;
    const info = node.text_post_app_info;
    if (!info || typeof info !== "object") c.noInfo++;
    else if (!("reply_to_author" in info)) c.noField++;
    else if (info.reply_to_author == null) c.nullTo++;
    else c.replyTo++;
    const where = path.filter((k) => !/^\d+$/.test(k)).slice(-4).join(".") || "(корень)";
    this.shapePaths[where] = (this.shapePaths[where] || 0) + 1;
    if (!this.shapeSample) {
      const infoKeys = info && typeof info === "object" ? Object.keys(info).slice(0, 12).join(",") : "-";
      this.shapeSample = `@${node.user?.username} ключи {${Object.keys(node).slice(0, 14).join(",")}} text_post_app_info {${infoKeys}}`;
    }
  }

  /**
   * Итоговый список. Обычно - строгие ответы (reply_to_author задан).
   * Если пост для аккаунта недоступен («Post not available»), Threads отдаёт ответы БЕЗ reply_to_author,
   * и строгий фильтр выбрасывает всё. Тогда берём отброшенные посты чужих авторов
   * (посты самого автора в этом случае - скорее «ещё от автора», чем ответы).
   */
  get bestReplies(): FeedReply[] {
    if (this.replies.length) return this.replies;
    if (this.loose.length) return this.loose.filter((r) => !this.ancestors.has(r.code));
    if (this.mainSeen) return this.replies;
    if (this.soft.length) return this.soft.filter((r) => !this.ancestors.has(r.code));
    const author = this.mainAuthor ? "@" + this.mainAuthor : "";
    return this.droppedTopLevel.filter((r) => !this.ancestors.has(r.code) && (!author || r.author !== author));
  }

  /** Короткая сводка для диагностики пустого результата. */
  stats(): string {
    const ep = Object.entries(this.endpoints).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, v]) => `${k}×${v}`).join(", ");
    return `ответов ${this.replies.length} (вне thread_items ${this.loose.length}, мягко ${this.soft.length}), пост в JSON ${this.mainSeen ? "да" : this.mainSeenAnywhere ? "да (вне thread_items)" : "нет"}, ответов сети ${this.responses} (с кодом поста ${this.textsWithMain}, с thread_items ${this.textsWithThreads}${ep ? `; ${ep}` : ""}), отброшено «не ответ» ${this.droppedTopLevel.length}, недоступных ${this.droppedUnavailable}`;
  }

  ingestJson(root: any, hasMain?: boolean): number {
    const before = this.replies.length;
    this.responses++;
    this.curHasMain = hasMain ?? JSON.stringify(root ?? null).includes(this.mainCode);
    this.walk(root, 0, []);
    return this.replies.length - before;
  }

  private takeThread(items: any[]): void {
    const posts = items.map((it) => it?.post).filter((p) => isThreadsPost(p));
    for (const p of posts) this.threadCodes.add(String(p.code));
    const mainIdx = posts.findIndex((p) => p.code === this.mainCode);
    if (mainIdx >= 0) {
      this.mainSeen = true;
      // Всё, что выше поста в его цепочке, - предки (пост, на который он отвечает), не комментарии
      for (const p of posts.slice(0, mainIdx)) this.markAncestor(String(p.code));
      for (const p of posts.slice(mainIdx + 1)) this.add(p);
      return;
    }
    for (const p of posts) this.add(p);
  }

  /** Пост вне thread_items: ответ, если у него заполнен reply_to_author */
  private addLoose(node: any, path: string[] = []): void {
    const code = String(node.code);
    if (code === this.mainCode) { this.mainSeenAnywhere = true; return; }
    if (this.threadCodes.has(code) || this.looseCodes.has(code) || this.ancestors.has(code)) return;
    const info = node.text_post_app_info;
    if (info != null && typeof info !== "object") return;
    if (info?.is_post_unavailable === true) return;
    const p = normalizeThreadsPost(node);
    if (!p) return;
    const reply: FeedReply = {
      code,
      author: "@" + (p.author || "anonymous"),
      text: p.text || (p.has_video ? "🎥" : p.has_image ? "📷" : ""),
      avatar: p.authorAvatar,
      likes: p.likes,
    };
    if (!info || !("reply_to_author" in info)) {
      // Неизвестная форма: берём только если документ относится к этому посту и это не цитата/репост внутри поста
      const embedded = path.some((k) => /quot|repost|share|attach|link_preview/i.test(k));
      if (this.curHasMain && !embedded && !this.softCodes.has(code)) { this.softCodes.add(code); this.soft.push(reply); }
      return;
    }
    // Любое непустое значение (объект с username, id, строка) - это ответ; null - верхний уровень
    const to = info.reply_to_author;
    if (!to) return;
    this.looseCodes.add(code);
    this.loose.push(reply);
  }

  private markAncestor(code: string): void {
    this.ancestors.add(code);
    const i = this.replies.findIndex((r) => r.code === code);
    if (i >= 0) this.replies.splice(i, 1);
  }

  private add(node: any): void {
    const code = String(node.code);
    if (code === this.mainCode || this.ancestors.has(code) || this.codes.has(code)) return;
    const info = node.text_post_app_info;
    if (info?.is_post_unavailable === true) { this.droppedUnavailable++; return; }
    const p = normalizeThreadsPost(node);
    if (!p) return;
    const reply: FeedReply = {
      code,
      author: "@" + (p.author || "anonymous"),
      text: p.text || (p.has_video ? "🎥" : p.has_image ? "📷" : ""),
      avatar: p.authorAvatar,
      likes: p.likes,
    };
    // Пост верхнего уровня (рекомендации, «ещё от автора») - не ответ; запоминаем на случай недоступного поста
    if (info && typeof info === "object" && "reply_to_author" in info && info.reply_to_author == null) {
      if (!this.droppedCodes.has(code)) { this.droppedCodes.add(code); this.droppedTopLevel.push(reply); }
      return;
    }
    this.codes.add(code);
    this.replies.push(reply);
  }

  private walk(node: any, depth: number, path: string[]): void {
    if (!node || typeof node !== "object" || depth > 40) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) this.walk(node[i], depth + 1, path);
      return;
    }
    if (isThreadsPost(node)) this.noteShape(node, path);
    if (Array.isArray(node.thread_items)) this.takeThread(node.thread_items);
    else if (isThreadsPost(node)) this.addLoose(node, path);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (v && typeof v === "object") this.walk(v, depth + 1, path.length < 12 ? [...path, k] : path);
    }
  }
}
