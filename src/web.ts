import type { Env } from "./config";
import type { Comment, Post, ProfileData } from "./threads";

export type Lang = "ru" | "en";

export const POPULAR_CREATORS = [
  { username: "durov", label_ru: "Павел Дуров", label_en: "Pavel Durov" },
  { username: "zuck", label_ru: "Марк Цукерберг", label_en: "Mark Zuckerberg" },
  { username: "mkbhd", label_ru: "Marques Brownlee", label_en: "MKBHD" },
  { username: "alina.kuzina", label_ru: "Алина Кузина", label_en: "Alina Kuzina" },
  { username: "yaz.anton", label_ru: "Антон Яз", label_en: "Anton Yaz" },
  { username: "hhressko", label_ru: "Hhressko", label_en: "Hhressko" },
  { username: "temalebedev", label_ru: "Артемий Лебедев", label_en: "Artemy Lebedev" },
  { username: "wylsacom", label_ru: "Wylsacom", label_en: "Wylsacom" },
  { username: "mosseri", label_ru: "Адам Моссери", label_en: "Adam Mosseri" },
  { username: "mrbeast", label_ru: "MrBeast", label_en: "MrBeast" },
  { username: "openai", label_ru: "OpenAI", label_en: "OpenAI" },
  { username: "techcrunch", label_ru: "TechCrunch", label_en: "TechCrunch" },
  { username: "leomessi", label_ru: "Leo Messi", label_en: "Leo Messi" },
  { username: "shakira", label_ru: "Shakira", label_en: "Shakira" },
];

export function detectLanguage(request: Request): Lang {
  const url = new URL(request.url);
  const q = url.searchParams.get("lang")?.toLowerCase();
  if (q === "en" || q === "ru") return q;

  const cookieHeader = request.headers.get("cookie") || "";
  const match = cookieHeader.match(/(?:^|;\s*)lang=(ru|en)/i);
  if (match) return match[1].toLowerCase() as Lang;

  const accept = (request.headers.get("accept-language") || "").toLowerCase();
  if (accept.startsWith("ru") || accept.includes(",ru") || accept.includes("be") || accept.includes("uk")) {
    return "ru";
  }

  const country = (request.headers.get("cf-ipcountry") || (request as any).cf?.country || "").toUpperCase();
  const cisCountries = ["RU", "BY", "KZ", "UA", "KG", "UZ", "TJ", "AM", "AZ", "MD"];
  if (cisCountries.includes(country)) {
    return "ru";
  }

  return "en";
}

export function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatPostText(text: string): string {
  const escaped = esc(text);
  const withUrls = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="post-link">$1</a>');
  const withMentions = withUrls.replace(/(^|\s)@([A-Za-z0-9._]+)/g, '$1<a href="/@$2" class="post-mention">@$2</a>');
  const withTags = withMentions.replace(/(^|\s)#([\w\u0400-\u04FF]+)/g, '$1<span class="post-hashtag">#$2</span>');
  return withTags.replace(/\n/g, "<br>");
}

function safeMediaUrl(raw: string): string {
  if (!raw) return "";
  return raw.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&quot;/g, '"');
}

export function formatDisplayDate(raw: string): string {
  if (!raw) return "";
  return raw.replace(/T/g, " ").replace(/:\d{2}(?:\.\d+)?Z$/i, "").replace(/Z$/i, "").trim();
}

function getBotUsername(env?: Env): string {
  return env?.BOT_USERNAME || "threadsreaderbot";
}

const COMMON_STYLES = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    --s: 180px;
    --c1: #161616;
    --c2: #242424;
    --c3: #1d1d1d;

    background: repeating-conic-gradient(
          from 30deg,
          #0000 0 120deg,
          var(--c3) 0 180deg
        )
        calc(0.5 * var(--s)) calc(0.5 * var(--s) * 0.577),
      repeating-conic-gradient(
        from 30deg,
        var(--c1) 0 60deg,
        var(--c2) 0 120deg,
        var(--c3) 0 180deg
      );
    background-size: var(--s) calc(var(--s) * 0.577);
    background-color: #161616;
    color: #e6e6e6;
    font-family: Arial, Helvetica, system-ui, sans-serif;
    line-height: 1.5;
    padding-bottom: 60px;
  }
  a { color: inherit; text-decoration: none; }

  /* Navbar */
  .navbar {
    position: sticky;
    top: 0;
    z-index: 100;
    background: #111111;
    border-bottom: 1px solid #2d2d2d;
    height: 52px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    max-width: 900px;
    margin: 0 auto;
    box-shadow: none;
  }
  .navbar-brand {
    font-weight: 700;
    font-size: 1rem;
    color: #ffffff;
    letter-spacing: -0.01em;
  }
  .navbar-search {
    flex: 1;
    max-width: 360px;
    margin: 0 14px;
  }
  .navbar-search input {
    width: 100%;
    background: #1c1c1c;
    border: 1px solid #333333;
    border-radius: 0;
    padding: 6px 10px;
    color: #ffffff;
    font-size: 0.88rem;
    outline: none;
    box-shadow: none;
  }
  .navbar-search input:focus {
    border-color: #666666;
  }
  .navbar-actions {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    flex-shrink: 0;
  }
  .btn-nav-tg,
  .btn-lang-toggle,
  .btn-theme-toggle {
    height: 32px;
    min-height: 32px;
    max-height: 32px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0 10px;
    font-size: 0.8rem;
    font-weight: 600;
    line-height: 1;
    border-radius: 0;
    cursor: pointer;
    text-decoration: none;
    white-space: nowrap;
    border: 1px solid #3d3d3d;
    background: #242424;
    color: #e0e0e0;
    font-family: inherit;
    box-shadow: none;
  }
  .btn-nav-tg {
    background: #2a2a2a;
    border-color: #444444;
    color: #ffffff;
    font-weight: 700;
  }
  .btn-nav-tg:hover {
    background: #363636;
    border-color: #666666;
  }
  .btn-lang-toggle:hover,
  .btn-theme-toggle:hover {
    background: #2e2e2e;
    border-color: #555555;
    color: #ffffff;
  }

  /* Notice Bar */
  .notice-bar {
    background: #111827;
    border-bottom: 2px solid #2563eb;
    color: #e2e8f0;
    font-size: 0.88rem;
    text-align: center;
    padding: 10px 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 14px;
    flex-wrap: wrap;
    box-shadow: none;
  }
  .notice-bar-highlight {
    color: #60a5fa;
    font-weight: 700;
  }
  .notice-bar a {
    background: #2563eb;
    border: 1px solid #3b82f6;
    color: #ffffff;
    padding: 6px 16px;
    border-radius: 0;
    font-size: 0.82rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    white-space: nowrap;
    text-decoration: none;
    box-shadow: none;
  }
  .notice-bar a:hover {
    background: #1d4ed8;
    border-color: #60a5fa;
  }

  /* Telegram Callout Card */
  .tg-callout-card {
    background: #131722;
    border: 1px solid #2563eb;
    border-radius: 0;
    padding: 16px 18px;
    margin: 18px 0;
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
    box-shadow: none;
  }
  .tg-callout-left {
    width: 100%;
    text-align: left;
  }
  .tg-callout-badge {
    display: inline-block;
    background: #1e293b;
    border: 1px solid #3b82f6;
    color: #93c5fd;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 2px 7px;
    margin-bottom: 6px;
  }
  .tg-callout-title {
    font-size: 1.02rem;
    font-weight: 700;
    color: #ffffff;
    margin-bottom: 6px;
    line-height: 1.35;
  }
  .tg-callout-desc {
    font-size: 0.86rem;
    color: #cbd5e1;
    line-height: 1.5;
  }
  .tg-callout-btn {
    background: #2563eb;
    border: 1px solid #3b82f6;
    color: #ffffff;
    padding: 11px 18px;
    font-size: 0.9rem;
    font-weight: 700;
    text-align: center;
    text-decoration: none;
    border-radius: 0;
    box-shadow: none;
    display: block;
    width: 100%;
    box-sizing: border-box;
  }
  .tg-callout-btn:hover {
    background: #1d4ed8;
    border-color: #60a5fa;
  }
  .btn-sharp-tg {
    background: #172554 !important;
    border: 1px solid #2563eb !important;
    color: #93c5fd !important;
    font-weight: 700;
  }
  .btn-sharp-tg:hover {
    background: #1e3a8a !important;
    border-color: #3b82f6 !important;
    color: #ffffff !important;
  }

  /* Main Container */
  .container {
    max-width: 620px;
    margin: 20px auto;
    padding: 0 12px;
  }

  /* Hero */
  .hero-card {
    background: #131313;
    border: 1px solid #2d2d2d;
    border-radius: 0;
    padding: 24px 20px;
    margin-bottom: 16px;
    box-shadow: none;
  }
  .hero-tag {
    font-size: 0.75rem;
    color: #888888;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 8px;
  }
  .hero-title {
    font-size: 1.5rem;
    font-weight: 700;
    color: #ffffff;
    margin-bottom: 8px;
    line-height: 1.3;
  }
  .hero-subtitle {
    color: #999999;
    font-size: 0.9rem;
    margin-bottom: 18px;
  }
  .hero-search-form {
    display: flex;
    gap: 8px;
    margin-bottom: 12px;
  }
  .hero-search-form input {
    flex: 1;
    background: #1c1c1c;
    border: 1px solid #333333;
    border-radius: 0;
    color: #ffffff;
    padding: 10px 12px;
    font-size: 0.95rem;
    outline: none;
    box-shadow: none;
  }
  .hero-search-form input:focus {
    border-color: #666666;
  }
  .hero-search-form button {
    background: #2b2b2b;
    border: 1px solid #444444;
    color: #ffffff;
    border-radius: 0;
    padding: 10px 18px;
    font-size: 0.9rem;
    font-weight: 700;
    cursor: pointer;
    box-shadow: none;
  }
  .hero-search-form button:hover {
    background: #363636;
  }

  .example-hint {
    font-size: 0.82rem;
    color: #888888;
    margin-top: 8px;
  }
  .blue-example-link {
    color: #3b82f6;
    text-decoration: underline;
    font-weight: 600;
    cursor: pointer;
  }

  /* Profile Header */
  .profile-card {
    background: #131313;
    border: 1px solid #2d2d2d;
    border-radius: 0;
    padding: 20px;
    margin-bottom: 16px;
    box-shadow: none;
  }
  .profile-top-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
  }
  .profile-title-block {
    flex: 1;
  }
  .profile-name {
    font-size: 1.35rem;
    font-weight: 700;
    color: #ffffff;
  }
  .profile-handle {
    font-size: 0.88rem;
    color: #888888;
    margin-top: 2px;
  }
  .profile-avatar-box {
    width: 64px;
    height: 64px;
    background: #202020;
    border: 1px solid #333333;
    border-radius: 0;
    overflow: hidden;
    flex-shrink: 0;
  }
  .profile-avatar-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .profile-bio {
    margin-top: 12px;
    font-size: 0.9rem;
    color: #cccccc;
    line-height: 1.45;
  }
  .profile-stats-row {
    margin-top: 14px;
    display: flex;
    gap: 16px;
    font-size: 0.8rem;
    color: #888888;
  }
  .profile-actions {
    margin-top: 16px;
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .btn-sharp {
    background: #242424;
    border: 1px solid #383838;
    border-radius: 0;
    color: #ffffff;
    padding: 7px 14px;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    box-shadow: none;
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .btn-sharp:hover {
    background: #2d2d2d;
  }

  /* Feed & Posts */
  .feed {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .post-card {
    background: #131313;
    border: 1px solid #262626;
    border-radius: 0;
    padding: 16px;
    box-shadow: none;
  }
  .post-card-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 10px;
  }
  .post-author-block {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .post-author-avatar {
    width: 32px;
    height: 32px;
    background: #222222;
    border: 1px solid #333333;
    border-radius: 0;
    object-fit: cover;
  }
  .post-author-handle {
    font-weight: 700;
    font-size: 0.88rem;
    color: #ffffff;
  }
  .post-timestamp {
    font-size: 0.75rem;
    color: #777777;
  }
  .post-body-text {
    font-size: 0.92rem;
    color: #d6d6d6;
    line-height: 1.45;
    word-break: break-word;
    margin-bottom: 10px;
  }
  .post-link { color: #8ab4f8; text-decoration: underline; }
  .post-mention { color: #ffffff; font-weight: 600; }
  .post-hashtag { color: #8ab4f8; }

  .post-media-box {
    border: 1px solid #222222;
    border-radius: 0;
    background: #0c0c0c;
    margin-bottom: 10px;
    max-height: 480px;
    overflow: hidden;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .post-media-box img {
    width: 100%;
    max-height: 480px;
    object-fit: contain;
    display: block;
    cursor: pointer;
  }
  .post-media-box video {
    width: 100%;
    max-height: 480px;
    object-fit: contain;
    display: block;
    background: #000;
  }
  .video-indicator {
    display: inline-block;
    border: 1px solid #333333;
    background: #1c1c1c;
    padding: 2px 6px;
    font-size: 0.72rem;
    color: #aaaaaa;
    margin-bottom: 8px;
  }

  .history-section {
    margin-top: 24px;
    text-align: left;
    width: 100%;
    max-width: 620px;
    margin-left: auto;
    margin-right: auto;
  }
  .history-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
    border-bottom: 1px solid #282828;
    padding-bottom: 6px;
  }
  .history-title {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: #888888;
    font-weight: 600;
  }
  .history-clear-btn {
    background: transparent;
    border: none;
    color: #777777;
    font-size: 0.78rem;
    cursor: pointer;
    font-family: inherit;
    text-decoration: underline;
    padding: 0;
  }
  .history-clear-btn:hover {
    color: #bbbbbb;
  }
  .history-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .history-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    background: #141414;
    border: 1px solid #2a2a2a;
    color: #cccccc;
    text-decoration: none;
    font-size: 0.82rem;
  }
  .history-chip:hover {
    background: #1f1f1f;
    border-color: #444444;
    color: #ffffff;
  }
  .history-chip-avatar {
    color: #8ab4f8;
    font-size: 0.75rem;
    font-weight: bold;
  }
  html[data-theme="light"] .history-section {
    border-color: #b5ab99;
  }
  html[data-theme="light"] .history-header {
    border-bottom: 1px solid #c0b6a4;
  }
  html[data-theme="light"] .history-title {
    color: #635b4f;
  }
  html[data-theme="light"] .history-clear-btn {
    color: #736b5d;
  }
  html[data-theme="light"] .history-chip {
    background: #ded5c6;
    border: 1px solid #b8ad9b;
    color: #2e2820;
  }
  html[data-theme="light"] .history-chip:hover {
    background: #e6ddce;
    border-color: #8f8473;
    color: #000000;
  }
  html[data-theme="light"] .history-chip-avatar {
    color: #1a56a6;
  }

  /* Popular section */
  .popular-section {
    margin-top: 20px;
    text-align: left;
    width: 100%;
    max-width: 620px;
    margin-left: auto;
    margin-right: auto;
  }
  .popular-header {
    margin-bottom: 8px;
    border-bottom: 1px solid #282828;
    padding-bottom: 4px;
  }
  .popular-title {
    font-size: 0.76rem;
    text-transform: uppercase;
    letter-spacing: 0.8px;
    color: #888888;
    font-weight: 600;
  }
  .popular-list {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
  }
  .creator-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    background: #141414;
    border: 1px solid #282828;
    color: #cccccc;
    text-decoration: none;
    font-size: 0.82rem;
  }
  .creator-chip:hover {
    background: #1f1f1f;
    border-color: #444444;
    color: #ffffff;
  }
  .creator-chip-at {
    color: #0084ff;
    font-weight: bold;
    font-size: 0.8rem;
  }
  .creator-chip-name {
    font-weight: 600;
  }
  .creator-chip-desc {
    font-size: 0.74rem;
    color: #777777;
    margin-left: 2px;
  }
  html[data-theme="light"] .popular-header {
    border-bottom: 1px solid #c0b6a4;
  }
  html[data-theme="light"] .popular-title {
    color: #635b4f;
  }
  html[data-theme="light"] .creator-chip {
    background: #ded5c6;
    border: 1px solid #b8ad9b;
    color: #2e2820;
  }
  html[data-theme="light"] .creator-chip:hover {
    background: #e6ddce;
    border-color: #8f8473;
    color: #000000;
  }
  html[data-theme="light"] .creator-chip-at {
    color: #1a56a6;
  }
  html[data-theme="light"] .creator-chip-desc {
    color: #736b5d;
  }

  .post-card.post-highlighted {
    border: 2px solid #0084ff;
  }
  html[data-theme="light"] .post-card.post-highlighted {
    border: 2px solid #1a56a6;
  }

  .post-toolbar {
    display: flex;
    align-items: center;
    gap: 14px;
    padding-top: 10px;
    border-top: 1px solid #202020;
    font-size: 0.82rem;
    color: #888888;
  }
  .toolbar-btn {
    background: none;
    border: none;
    color: inherit;
    font-size: 0.82rem;
    cursor: pointer;
    padding: 2px 4px;
  }
  .toolbar-btn:hover {
    color: #ffffff;
  }
  .toolbar-btn.active {
    color: #ffffff;
    font-weight: 700;
  }

  .post-metric {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    font-size: 0.82rem;
    color: #999999;
    user-select: none;
  }
  .post-metric-icon {
    font-size: 0.95rem;
  }
  .post-metric-val {
    font-weight: 700;
    color: #cccccc;
  }
  .comment-count {
    color: #888888;
    font-size: 0.78rem;
    margin-left: 2px;
  }

  /* Comments */
  .comments-box {
    margin-top: 10px;
    padding: 12px 14px;
    background: #0f0f0f;
    border-top: 1px solid #202020;
    display: none;
  }
  .comments-loading {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    font-size: 0.82rem;
    color: #888888;
  }
  .loading-bar {
    display: inline-block;
    width: 12px;
    height: 3px;
    background: #0084ff;
  }
  .comments-empty {
    font-size: 0.82rem;
    color: #777777;
    padding: 6px 0;
  }
  .comments-error {
    font-size: 0.82rem;
    color: #f87171;
    padding: 6px 0;
  }
  .comment-row {
    padding: 8px 0;
    border-bottom: 1px solid #1c1c1c;
    font-size: 0.82rem;
  }
  .comment-row:last-child { border-bottom: none; }
  .comment-author-block {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 3px;
  }
  .comment-author-avatar {
    width: 22px;
    height: 22px;
    border-radius: 0;
    border: 1px solid #333333;
    background: #1f1f1f;
    object-fit: cover;
    flex-shrink: 0;
  }
  .comment-author-name {
    font-weight: 700;
    color: #ffffff;
  }
  .comment-author-name a {
    color: inherit;
    text-decoration: none;
  }
  .comment-author-name a:hover {
    text-decoration: underline;
  }
  .comment-content {
    color: #b5b5b5;
    line-height: 1.4;
    word-break: break-word;
    padding-left: 28px;
  }

  /* Sponsor / Partner Box */
  .sponsor-card {
    background: #131313;
    border: 1px solid #303030;
    border-radius: 0;
    padding: 16px;
    margin: 14px 0;
  }
  .sponsor-card-top {
    font-size: 0.7rem;
    text-transform: uppercase;
    color: #777777;
    letter-spacing: 0.05em;
    display: flex;
    justify-content: space-between;
    margin-bottom: 6px;
  }
  .sponsor-card-inner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    flex-wrap: wrap;
  }
  .sponsor-text h4 {
    font-size: 0.95rem;
    color: #ffffff;
    margin-bottom: 4px;
  }
  .sponsor-text p {
    font-size: 0.82rem;
    color: #999999;
  }
  .sponsor-btn {
    background: #2a2a2a;
    border: 1px solid #444444;
    border-radius: 0;
    color: #ffffff;
    padding: 6px 14px;
    font-size: 0.82rem;
    font-weight: 700;
    white-space: nowrap;
    cursor: pointer;
  }
  .sponsor-btn:hover {
    background: #353535;
  }

  /* Status & Error Card (Prominent & Noticeable) */
  .status-card {
    background: #141414;
    border: 1px solid #2d2d2d;
    padding: 22px 18px;
    margin: 16px 0;
    text-align: left;
    box-shadow: none;
    border-radius: 0;
  }
  .status-card-loading {
    border-left: 4px solid #0084ff;
  }
  .status-card-error {
    border-left: 4px solid #ef4444;
    background: #1c1414;
    border-color: #442222;
  }
  .status-card-header {
    display: flex;
    align-items: center;
    gap: 10px;
    margin-bottom: 8px;
  }
  .status-indicator-box {
    width: 10px;
    height: 10px;
    background: #0084ff;
    display: inline-block;
    flex-shrink: 0;
  }
  .status-card-error .status-indicator-box {
    background: #ef4444;
  }
  .status-card h3 {
    font-size: 1.05rem;
    font-weight: 700;
    color: #ffffff;
    margin: 0;
  }
  .status-card p {
    font-size: 0.88rem;
    color: #aaaaaa;
    line-height: 1.45;
    margin: 0;
  }
  .status-card-error h3 {
    color: #fca5a5;
  }
  .status-card-error p {
    color: #f87171;
  }

  /* Lightbox */
  .lightbox-overlay {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0, 0, 0, 0.95);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 12px;
  }
  .lightbox-overlay img {
    max-width: 95%;
    max-height: 92vh;
    border: 1px solid #333333;
    border-radius: 0;
  }
  .lightbox-close-btn {
    position: absolute;
    top: 14px;
    right: 20px;
    color: #ffffff;
    font-size: 26px;
    cursor: pointer;
    background: none;
    border: none;
  }

  /* Support Form */
  .support-card {
    background: #141414;
    border: 1px solid #282828;
    padding: 18px;
    margin: 24px auto 0;
    max-width: 620px;
    text-align: left;
    box-shadow: none;
    border-radius: 0;
  }
  .support-title {
    font-size: 0.95rem;
    font-weight: 600;
    color: #e0e0e0;
    margin-bottom: 6px;
  }
  .support-desc {
    font-size: 0.8rem;
    color: #888888;
    margin-bottom: 14px;
    line-height: 1.4;
  }
  .support-field {
    margin-bottom: 12px;
  }
  .support-label {
    display: block;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.6px;
    color: #888888;
    margin-bottom: 6px;
    font-weight: 600;
  }
  .support-input,
  .support-textarea {
    width: 100%;
    box-sizing: border-box;
    background: #1c1c1c;
    border: 1px solid #333333;
    color: #eeeeee;
    padding: 8px 10px;
    font-family: inherit;
    font-size: 0.84rem;
    outline: none;
    border-radius: 0;
  }
  .support-input:focus,
  .support-textarea:focus {
    border-color: #555555;
  }
  .support-textarea {
    resize: vertical;
    min-height: 70px;
  }
  .support-btn {
    background: #242424;
    border: 1px solid #3c3c3c;
    color: #dddddd;
    padding: 8px 18px;
    font-family: inherit;
    font-size: 0.84rem;
    cursor: pointer;
    border-radius: 0;
    font-weight: 600;
  }
  .support-btn:hover {
    background: #2e2e2e;
    border-color: #555555;
    color: #ffffff;
  }
  .support-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }
  .support-feedback {
    margin-top: 10px;
    padding: 8px 12px;
    font-size: 0.82rem;
    border: 1px solid #333333;
    background: #181818;
  }
  .support-feedback.success {
    color: #81c784;
    border-color: #2e7d32;
    background: #102413;
  }
  .support-feedback.error {
    color: #e57373;
    border-color: #c62828;
    background: #2b1111;
  }

  /* FAQ Section */
  .faq-card {
    max-width: 620px;
    margin: 24px auto 0;
    padding: 20px 24px;
    background: #141414;
    border: 1px solid #282828;
    border-radius: 0;
    text-align: left;
    box-shadow: none;
  }
  .faq-main-title {
    font-size: 1.15rem;
    font-weight: 700;
    color: #ffffff;
    margin-bottom: 16px;
    letter-spacing: -0.2px;
  }
  .faq-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .faq-item {
    background: #181818;
    border: 1px solid #262626;
    border-radius: 0;
    padding: 12px 14px;
  }
  .faq-item[open] {
    border-color: #3b82f6;
  }
  .faq-question {
    font-size: 0.92rem;
    font-weight: 600;
    color: #eeeeee;
    cursor: pointer;
    outline: none;
    user-select: none;
  }
  .faq-question:hover {
    color: #3b82f6;
  }
  .faq-answer {
    margin-top: 10px;
    font-size: 0.86rem;
    line-height: 1.55;
    color: #aaaaaa;
    border-top: 1px solid #252525;
    padding-top: 8px;
  }

  /* Toast */
  .toast-box {
    position: fixed;
    bottom: 20px;
    left: 50%;
    transform: translateX(-50%);
    background: #242424;
    border: 1px solid #444444;
    border-radius: 0;
    color: #ffffff;
    font-size: 0.85rem;
    padding: 8px 16px;
    z-index: 1001;
    display: none;
  }

  /* Footer */
  .footer-block {
    max-width: 620px;
    margin: 30px auto 0;
    padding: 16px 12px;
    border-top: 1px solid #242424;
    text-align: center;
    font-size: 0.78rem;
    color: #777777;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .footer-links-row {
    display: flex;
    justify-content: center;
    gap: 16px;
  }
  .footer-links-row a {
    color: #999999;
  }
  .footer-links-row a:hover {
    color: #ffffff;
    text-decoration: underline;
  }

  /* ==========================================
     LIGHT THEME (WARM MATTE BEIGE)
     ========================================== */
  html[data-theme="light"] body {
    --s: 180px;
    --c1: #d3cbbe;
    --c2: #c6bdad;
    --c3: #ccc4b5;
    background: repeating-conic-gradient(
          from 30deg,
          #0000 0 120deg,
          var(--c3) 0 180deg
        )
        calc(0.5 * var(--s)) calc(0.5 * var(--s) * 0.577),
      repeating-conic-gradient(
        from 30deg,
        var(--c1) 0 60deg,
        var(--c2) 0 120deg,
        var(--c3) 0 180deg
      );
    background-size: var(--s) calc(var(--s) * 0.577);
    background-color: #d3cbbe;
    color: #24201a;
  }
  html[data-theme="light"] .navbar {
    background: #dbd3c5;
    border-bottom: 1px solid #b5ab99;
  }
  html[data-theme="light"] .navbar-brand {
    color: #201c17;
  }
  html[data-theme="light"] .navbar-search input {
    background: #e6dfd2;
    border: 1px solid #b5ab99;
    color: #201c17;
  }
  html[data-theme="light"] .navbar-search input:focus {
    border-color: #635b4d;
  }
  html[data-theme="light"] .btn-nav-tg,
  html[data-theme="light"] .btn-lang-toggle,
  html[data-theme="light"] .btn-theme-toggle {
    height: 32px;
    min-height: 32px;
    max-height: 32px;
    box-sizing: border-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    border: 1px solid #aba08d;
    background: #cec5b5;
    color: #24201a;
  }
  html[data-theme="light"] .btn-nav-tg {
    background: #24201a;
    border-color: #24201a;
    color: #f7f4ee;
    font-weight: 700;
  }
  html[data-theme="light"] .btn-nav-tg:hover {
    background: #363128;
  }
  html[data-theme="light"] .btn-lang-toggle:hover,
  html[data-theme="light"] .btn-theme-toggle:hover {
    background: #c3b9a7;
    border-color: #8c826f;
    color: #171410;
  }
  html[data-theme="light"] .notice-bar {
    background: #e2edfd;
    border-bottom: 2px solid #2563eb;
    color: #1e293b;
  }
  html[data-theme="light"] .notice-bar-highlight {
    color: #1d4ed8;
  }
  html[data-theme="light"] .notice-bar a {
    background: #2563eb;
    border: 1px solid #1d4ed8;
    color: #ffffff;
  }
  html[data-theme="light"] .notice-bar a:hover {
    background: #1d4ed8;
  }
  html[data-theme="light"] .tg-callout-card {
    background: #e8f0fe;
    border: 1px solid #2563eb;
  }
  html[data-theme="light"] .tg-callout-badge {
    background: #dbeafe;
    border: 1px solid #2563eb;
    color: #1d4ed8;
  }
  html[data-theme="light"] .tg-callout-title {
    color: #0f172a;
  }
  html[data-theme="light"] .tg-callout-desc {
    color: #334155;
  }
  html[data-theme="light"] .tg-callout-btn {
    background: #2563eb;
    border: 1px solid #1d4ed8;
    color: #ffffff;
  }
  html[data-theme="light"] .tg-callout-btn:hover {
    background: #1d4ed8;
  }
  html[data-theme="light"] .btn-sharp-tg {
    background: #e0ecff !important;
    border: 1px solid #2563eb !important;
    color: #1d4ed8 !important;
  }
  html[data-theme="light"] .btn-sharp-tg:hover {
    background: #c7ddff !important;
    border-color: #1e40af !important;
  }
  html[data-theme="light"] .hero-card,
  html[data-theme="light"] .profile-card,
  html[data-theme="light"] .post-card,
  html[data-theme="light"] .sponsor-card,
  html[data-theme="light"] .terms-card {
    background: #dbd3c5;
    border: 1px solid #b5ab99;
    color: #24201a;
  }
  html[data-theme="light"] .hero-tag,
  html[data-theme="light"] .sponsor-card-top span {
    color: #5c5548;
  }
  html[data-theme="light"] .hero-title,
  html[data-theme="light"] .profile-name,
  html[data-theme="light"] .sponsor-title,
  html[data-theme="light"] .terms-card h1,
  html[data-theme="light"] .terms-card h2 {
    color: #201c17;
  }
  html[data-theme="light"] .hero-subtitle,
  html[data-theme="light"] .profile-handle,
  html[data-theme="light"] .sponsor-desc,
  html[data-theme="light"] .terms-card p {
    color: #574f43;
  }
  html[data-theme="light"] .search-input,
  html[data-theme="light"] .hero-search-form input {
    background: #e6dfd2;
    border: 1px solid #b5ab99;
    color: #201c17;
  }
  html[data-theme="light"] .search-input:focus,
  html[data-theme="light"] .hero-search-form input:focus {
    border-color: #635b4d;
  }
  html[data-theme="light"] .search-btn,
  html[data-theme="light"] .hero-search-form button {
    background: #24201a;
    color: #f7f4ee;
  }
  html[data-theme="light"] .search-btn:hover,
  html[data-theme="light"] .hero-search-form button:hover {
    background: #363128;
  }
  html[data-theme="light"] .search-hint,
  html[data-theme="light"] .example-hint {
    color: #6b6354;
  }
  html[data-theme="light"] .blue-example-link {
    color: #1a56a6;
  }
  html[data-theme="light"] .profile-avatar-box,
  html[data-theme="light"] .post-author-avatar {
    background: #cdc4b3;
    border: 1px solid #b5ab99;
  }
  html[data-theme="light"] .profile-bio {
    color: #2c2720;
  }
  html[data-theme="light"] .profile-stats-row {
    color: #5c5548;
  }
  html[data-theme="light"] .btn-sharp {
    background: #cec5b5;
    border: 1px solid #aba08d;
    color: #24201a;
  }
  html[data-theme="light"] .btn-sharp:hover {
    background: #c3b9a7;
    border-color: #8c826f;
  }
  html[data-theme="light"] .post-author-handle {
    color: #201c17;
  }
  html[data-theme="light"] .post-timestamp {
    color: #665e50;
  }
  html[data-theme="light"] .post-body-text {
    color: #26211a;
  }
  html[data-theme="light"] .post-mention {
    color: #14120e;
  }
  html[data-theme="light"] .post-link,
  html[data-theme="light"] .post-hashtag {
    color: #1a56a6;
  }
  html[data-theme="light"] .post-media-box {
    background: #d1c8b8;
    border: 1px solid #b5ab99;
  }
  html[data-theme="light"] .video-indicator {
    background: #cec5b5;
    border: 1px solid #aba08d;
    color: #4b453a;
  }
  html[data-theme="light"] .post-toolbar {
    border-top: 1px solid #c7bead;
    color: #574f43;
  }
  html[data-theme="light"] .post-metric {
    color: #50483c;
  }
  html[data-theme="light"] .post-metric-val {
    color: #201c17;
  }
  html[data-theme="light"] .toolbar-btn {
    color: #574f43;
  }
  html[data-theme="light"] .toolbar-btn:hover {
    color: #171410;
  }
  html[data-theme="light"] .comments-box {
    border-top: 1px solid #c7bead;
    background: #d4ccbe;
  }
  html[data-theme="light"] .comment-row {
    border-bottom: 1px solid #c7bead;
  }
  html[data-theme="light"] .comment-author-name,
  html[data-theme="light"] .comment-author-name a {
    color: #201c17;
  }
  html[data-theme="light"] .comment-author-avatar {
    border-color: #aba08d;
    background: #c6bdad;
  }
  html[data-theme="light"] .comment-content {
    color: #2e2820;
  }
  html[data-theme="light"] .comments-loading {
    color: #665e50;
  }
  html[data-theme="light"] .status-card {
    background: #dbd3c5;
    border: 1px solid #b5ab99;
  }
  html[data-theme="light"] .status-card-loading {
    border-left: 4px solid #1a56a6;
  }
  html[data-theme="light"] .status-card-loading h3 {
    color: #0d3870;
  }
  html[data-theme="light"] .status-card-loading p {
    color: #354259;
  }
  html[data-theme="light"] .status-card-error {
    background: #e6d3cf;
    border-color: #cfa8a2;
    border-left: 4px solid #b91c1c;
  }
  html[data-theme="light"] .status-card-error h3 {
    color: #7f1d1d;
  }
  html[data-theme="light"] .status-card-error p {
    color: #991b1b;
  }
  html[data-theme="light"] .sponsor-btn {
    background: #24201a;
    color: #f7f4ee;
  }
  html[data-theme="light"] .sponsor-btn:hover {
    background: #363128;
  }
  html[data-theme="light"] .support-card {
    background: #ded5c6;
    border: 1px solid #b5ab99;
  }
  html[data-theme="light"] .support-title {
    color: #241f17;
  }
  html[data-theme="light"] .support-desc {
    color: #635b4f;
  }
  html[data-theme="light"] .support-label {
    color: #635b4f;
  }
  html[data-theme="light"] .support-input,
  html[data-theme="light"] .support-textarea {
    background: #ede6da;
    border: 1px solid #b8ad9b;
    color: #222222;
  }
  html[data-theme="light"] .support-input:focus,
  html[data-theme="light"] .support-textarea:focus {
    border-color: #8f8473;
  }
  html[data-theme="light"] .support-btn {
    background: #cec4b3;
    border: 1px solid #9f9482;
    color: #222222;
  }
  html[data-theme="light"] .support-btn:hover {
    background: #c2b6a3;
    border-color: #7b7161;
    color: #000000;
  }
  html[data-theme="light"] .support-feedback.success {
    color: #1b5e20;
    border-color: #81c784;
    background: #d8ead9;
  }
  html[data-theme="light"] .support-feedback.error {
    color: #b71c1c;
    border-color: #e57373;
    background: #f7dede;
  }
  html[data-theme="light"] .footer-block {
    border-top: 1px solid #b5ab99;
    color: #6b6354;
  }
  html[data-theme="light"] .footer-links-row a {
    color: #574f43;
  }
  html[data-theme="light"] .footer-links-row a:hover {
    color: #201c17;
  }

  html[data-theme="light"] .faq-card {
    background: #e6ded0;
    border-color: #b5ab99;
  }
  html[data-theme="light"] .faq-main-title {
    color: #1e1913;
  }
  html[data-theme="light"] .faq-item {
    background: #ded5c6;
    border-color: #b8ad9b;
  }
  html[data-theme="light"] .faq-item[open] {
    border-color: #1a56a6;
  }
  html[data-theme="light"] .faq-question {
    color: #2e2820;
  }
  html[data-theme="light"] .faq-question:hover {
    color: #1a56a6;
  }
  html[data-theme="light"] .faq-answer {
    color: #554d41;
    border-top-color: #c4b9a7;
  }

  /* Cookie banner */
  .cookie-banner {
    position: fixed;
    bottom: 12px;
    left: 14px;
    right: 14px;
    max-width: 868px;
    margin: 0 auto;
    z-index: 9999;
    background: #141618;
    border: 1px solid #2d2d2d;
    border-radius: 0;
    padding: 12px 16px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    font-size: 0.85rem;
    color: #cccccc;
    box-shadow: none;
  }
  .cookie-banner-text {
    line-height: 1.45;
    flex: 1;
  }
  .cookie-policy-link {
    color: #3b82f6;
    text-decoration: underline;
  }
  .cookie-banner-btn {
    background: #242424;
    color: #ffffff;
    border: 1px solid #444444;
    border-radius: 0;
    padding: 7px 18px;
    font-size: 0.84rem;
    font-weight: 600;
    cursor: pointer;
    white-space: nowrap;
    transition: none;
    box-shadow: none;
  }
  .cookie-banner-btn:hover {
    background: #333333;
    border-color: #666666;
  }
  html[data-theme="light"] .cookie-banner {
    background: #ece8df;
    border: 1px solid #b5ab99;
    color: #333333;
  }
  html[data-theme="light"] .cookie-policy-link {
    color: #0056b3;
  }
  html[data-theme="light"] .cookie-banner-btn {
    background: #dfdacb;
    border: 1px solid #a69a85;
    color: #111111;
  }
  html[data-theme="light"] .cookie-banner-btn:hover {
    background: #d4cec0;
    border-color: #887e6b;
  }
  .ad-free-link {
    font-size: 0.75rem;
    color: #888888;
    text-decoration: underline;
    margin-left: 10px;
  }
  .ad-free-link:hover {
    color: #cccccc;
  }
  html[data-theme="light"] .ad-free-link {
    color: #666666;
  }
  html[data-theme="light"] .ad-free-link:hover {
    color: #201c17;
  }
  .terms-subtitle {
    color: #888888;
    font-size: 0.82rem;
    margin-bottom: 16px;
  }
  html[data-theme="light"] .terms-subtitle {
    color: #777777;
  }

  @media (max-width: 640px) {
    .navbar-search { display: none; }
    .hero-title { font-size: 1.3rem; }
    .cookie-banner { flex-direction: column; align-items: stretch; gap: 10px; }
    .cookie-banner-btn { width: 100%; text-align: center; }
    .tg-callout-card {
      flex-direction: column;
      align-items: stretch;
      gap: 12px;
      padding: 14px 16px;
    }
    .tg-callout-left {
      width: 100%;
    }
    .tg-callout-btn {
      width: 100%;
      text-align: center;
      display: block;
      box-sizing: border-box;
    }
  }
`;

const I18N = {
  ru: {
    home_title: "Threads Viewer - Смотреть и читать Threads без VPN онлайн",
    home_desc: "Анонимный просмотр профилей, постов, фото и комментариев в Threads без VPN и регистрации. Удобный веб-ридер с поиском по авторам.",
    keywords: "threads без впн, смотреть тредс онлайн, читать threads анонимно, threads viewer, threads reader, threads без регистрации, профили threads, зеркало threads, тредс инстаграм, threads online, threads анонимно, threads войти, threads net что это за приложение",
    search_placeholder: "Поиск @username...",
    hero_search_placeholder: "Введите @username или threads.com/@...",
    hero_tag: "Анонимное веб-зеркало",
    hero_title: "Читайте Threads без VPN",
    hero_subtitle: "Введите никнейм автора или ссылку на тред, чтобы открыть посты, фото и комментарии прямо в браузере.",
    open_btn: "Открыть",
    example_hint: 'Например, <span id="exampleZuck" class="blue-example-link" onclick="fillSearch(\'zuck\')">zuck</span>',
    tg_badge: "Telegram-бот без VPN",
    tg_card_title: "Читайте Threads прямо в Telegram",
    tg_card_desc: "Отправляйте никнейм автора боту, читайте посты и комментарии, сохраняйте в избранное и получайте уведомления о новых публикациях.",
    tg_card_btn: "Перейти в Telegram-бота",
    notice_text: "Телеграм-бот Threads: читайте любые треды и комментарии прямо в Telegram без VPN.",
    open_bot_btn: "Открыть в Telegram",
    bot_link_text: "Telegram Бот",
    sponsor_tag: "Партнерский блок",
    sponsor_ad_label: "Реклама",
    sponsor_title: "Доступ к Threads и Instagram без ограничений",
    sponsor_desc: "Быстрый доступ к приложениям Meta на ПК и телефоне без зависаний.",
    sponsor_btn: "Подробнее",
    followers_label: "Подписчики",
    no_vpn_label: "Без VPN",
    anon_label: "Анонимный просмотр",
    sub_tg: "Подписаться в Telegram",
    share_profile: "Поделиться профилем",
    share_post: "Поделиться",
    in_bot: "В бот",
    comments: "Комментарии",
    like: "Нравится",
    video: "Видеозапись",
    load_more: "Загрузить еще посты",
    loading_posts: "Загрузка постов из Threads...",
    loading_comments: "Загрузка комментариев...",
    no_comments: "Комментариев нет.",
    no_posts: "Посты не найдены.",
    toast_profile_copied: "Ссылка скопирована",
    toast_post_copied: "Ссылка на пост скопирована",
    toast_invalid_username: "Введите корректный @username",
    toast_loading: "Загрузка постов...",
    toast_updated: "Посты обновлены",
    toast_all_loaded: "Все посты загружены",
    toast_error: "Не удалось загрузить",
    recent_profiles_title: "История просмотров",
    clear_history: "Очистить",
    popular_creators_title: "Популярные авторы",
    favorites_title: "Закладки",
    favorite_add: "В закладки",
    favorite_remove: "В закладках",
    track_in_bot: "Отслеживать в Telegram",
    support_title: "Остались вопросы? Напишите нам",
    support_desc: "Есть вопрос, идея или заметили ошибку? Отправьте сообщение, и оно поступит администратору в Telegram.",
    support_contact_label: "Куда ответить (необязательно)",
    support_contact_placeholder: "@username в Telegram или email (можно оставить пустым)",
    support_message_label: "Ваш вопрос или сообщение",
    support_message_placeholder: "Опишите ваш вопрос или предложение...",
    support_submit: "Отправить сообщение",
    support_sending: "Отправка...",
    support_success: "Спасибо! Ваше сообщение отправлено администратору.",
    support_error: "Не удалось отправить сообщение. Пожалуйста, попробуйте позже.",
    faq_main_title: "Часто задаваемые вопросы о Threads Viewer",
    faq_q1: "Как смотреть и читать Threads без VPN?",
    faq_a1: "Сервис Threads Viewer использует распределенную сеть серверов за пределами региональных ограничений. Сервер сам запрашивает открытые данные из Threads и передает их вам в чистом виде. Вы можете читать посты, смотреть фото и комментарии прямо в обычном браузере на смартфоне или компьютере без установки VPN-приложений.",
    faq_q2: "Нужна ли регистрация или авторизация через Instagram?",
    faq_a2: "Нет, регистрация и вход в аккаунт не требуются. Вы можете просматривать любые общедоступные профили и треды полностью анонимно. Ваша личная информация нигде не запрашивается и не сохраняется.",
    faq_q3: "Можно ли смотреть видеозаписи и ветки комментариев?",
    faq_a3: "Да, ридер отображает полные тексты публикаций, прикрепленные фотогалереи, видеоролики и ветки комментариев пользователей под каждым постом.",
    faq_q4: "Как работает официальный Telegram-бот?",
    faq_a4: "Наш Telegram-бот @threadsreaderbot позволяет читать треды прямо в мессенджере. Вы можете отправить боту никнейм автора (например, @zuck) и получать свежие посты. Кроме того, в боте доступна функция анонимного мониторинга: бот уведомит вас о публикации новых тредов интересующих вас авторов.",
    faq_q5: "Как отключить рекламу на сайте?",
    faq_a5: "Для отключения рекламных блоков достаточно оформить подписку в нашем Telegram-боте через команду /subscribe и перейти на сайт по персональной ссылке из команды /web.",
    tos: "Условия и тарифы",
    privacy: "Политика конфиденциальности",
    footer_text: "Threads Viewer. Независимый сервис. Не аффилирован с Meta Platforms Inc.",
    other_lang: "EN",
    other_lang_code: "en",
  },
  en: {
    home_title: "Threads Viewer - Anonymous Threads Viewer & Reader Online",
    home_desc: "Anonymous Threads viewer: browse public Threads profiles, posts, replies, and photos without account or VPN. Fast, anonymous web reader for Threads.",
    keywords: "anonymous threads viewer, thread anonymous viewer, threads viewer, read threads without account, view threads without login, threads reader online, threads anonymous viewer, threads web, browse threads",
    search_placeholder: "Search @username...",
    hero_search_placeholder: "Enter @username or threads.com/@...",
    hero_tag: "Anonymous web viewer",
    hero_title: "Anonymous Threads Viewer - Read Threads without VPN",
    hero_subtitle: "View and read public Threads profiles, posts, and replies online without account or VPN.",
    open_btn: "Open",
    example_hint: 'For example, <span id="exampleZuck" class="blue-example-link" onclick="fillSearch(\'zuck\')">zuck</span>',
    tg_badge: "Telegram Bot Without VPN",
    tg_card_title: "Read Threads directly in Telegram",
    tg_card_desc: "Send an author username to the bot to read threads and replies, bookmark creators, and get instant notifications for new posts.",
    tg_card_btn: "Open Telegram Bot",
    notice_text: "Telegram Bot Threads: read any thread and replies directly in Telegram without VPN.",
    open_bot_btn: "Open in Telegram",
    bot_link_text: "Telegram Bot",
    sponsor_tag: "Sponsored",
    sponsor_ad_label: "Ad",
    sponsor_title: "Unrestricted access to Threads and Instagram",
    sponsor_desc: "Fast, reliable connection to Meta services on desktop and mobile without lags.",
    sponsor_btn: "Learn more",
    followers_label: "Followers",
    no_vpn_label: "No VPN",
    anon_label: "Anonymous viewing",
    sub_tg: "Subscribe in Telegram",
    share_profile: "Share profile",
    share_post: "Share",
    in_bot: "In bot",
    comments: "Comments",
    like: "Like",
    video: "Video",
    load_more: "Load more posts",
    loading_posts: "Loading posts from Threads...",
    loading_comments: "Loading comments...",
    no_comments: "No comments yet.",
    no_posts: "No posts found.",
    toast_profile_copied: "Profile link copied",
    toast_post_copied: "Post link copied",
    toast_invalid_username: "Enter a valid @username",
    toast_loading: "Loading posts...",
    toast_updated: "Posts updated",
    toast_all_loaded: "All posts loaded",
    toast_error: "Failed to load",
    recent_profiles_title: "Recent profiles",
    clear_history: "Clear",
    popular_creators_title: "Popular creators",
    favorites_title: "Favorites",
    favorite_add: "Bookmark",
    favorite_remove: "Bookmarked",
    track_in_bot: "Track in Telegram",
    support_title: "Have questions? Contact us",
    support_desc: "Have a question, feedback, or found a bug? Send a message and it will be delivered directly to the admin in Telegram.",
    support_contact_label: "Contact info for reply (optional)",
    support_contact_placeholder: "Telegram @username or email (optional)",
    support_message_label: "Your question or message",
    support_message_placeholder: "Describe your question or feedback...",
    support_submit: "Send message",
    support_sending: "Sending...",
    support_success: "Thank you! Your message has been sent to the admin.",
    support_error: "Failed to send message. Please try again later.",
    faq_main_title: "Frequently Asked Questions",
    faq_q1: "How to read Threads without VPN?",
    faq_a1: "Threads Viewer operates on distributed edge servers. Our service fetches publicly available Threads content and delivers it directly to your browser. You can browse posts, photos, and replies on mobile or desktop without configuring VPN software.",
    faq_q2: "Do I need an account or Instagram login?",
    faq_a2: "No, no account or registration is required. You can browse public profiles and threads completely anonymously. We do not ask for or store any personal credentials.",
    faq_q3: "Can I view full comment threads and media?",
    faq_a3: "Yes, the viewer renders full post texts, image carousels, embedded videos, and complete user discussion threads beneath each post.",
    faq_q4: "How does the Telegram bot work?",
    faq_a4: "Our Telegram bot @threadsreaderbot allows you to read Threads directly inside Telegram. Send any username (e.g., @zuck) to get posts. You can also enable anonymous creator monitoring to receive instant push alerts when new posts are published.",
    faq_q5: "How to browse without ads?",
    faq_a5: "To disable all sponsor units, activate a subscription via our Telegram bot using /subscribe and open your personal ad-free link using the /web command.",
    tos: "Terms & Tariffs",
    privacy: "Privacy Policy",
    footer_text: "Threads Viewer. Independent service. Not affiliated with Meta Platforms Inc.",
    other_lang: "RU",
    other_lang_code: "ru",
  },
};

function renderNavbar(env: Env, lang: Lang, searchDefault = "", isPremium = false): string {
  const t = I18N[lang];
  const tgUser = getBotUsername(env);
  const premiumTag = isPremium
    ? `<span style="font-size:0.75rem;padding:2px 8px;background:#242424;border:1px solid #444;color:#ffd700;font-weight:600;display:inline-flex;align-items:center;">PREMIUM</span>`
    : "";
  return `
    <header class="navbar">
      <a href="/?lang=${lang}" class="navbar-brand">
        <span>Threads Viewer</span>
      </a>
      <div class="navbar-search">
        <form onsubmit="handleNavSearch(event)">
          <input type="text" id="navSearchInput" placeholder="${t.search_placeholder}" value="${esc(searchDefault)}" />
        </form>
      </div>
      <div class="navbar-actions">
        ${premiumTag}
        <button type="button" class="btn-theme-toggle" id="themeToggleBtn" onclick="toggleTheme()" title="Switch theme">
          <span id="themeToggleText">${lang === 'en' ? 'Light' : 'Светлая'}</span>
        </button>
        <a href="?lang=${t.other_lang_code}" onclick="setLangCookie('${t.other_lang_code}')" class="btn-lang-toggle" title="Switch language">
          ${t.other_lang}
        </a>
        <a href="https://t.me/${esc(tgUser)}" target="_blank" rel="noopener" class="btn-nav-tg">
          ${t.bot_link_text}
        </a>
      </div>
    </header>
  `;
}

function renderNoticeBar(env: Env, lang: Lang, username?: string, isPremium = false): string {
  const t = I18N[lang];
  if (isPremium) {
    return `
      <div class="notice-bar" style="background:#111827;border-bottom:2px solid #2563eb;color:#ffd700;">
        <span>${lang === 'en' ? 'Premium Active - Ad-free unlimited browsing' : 'Премиум активен - Без рекламы и ограничений'}</span>
      </div>
    `;
  }
  const tgUser = getBotUsername(env);
  const tgLink = username ? `https://t.me/${tgUser}?start=sub_${username}` : `https://t.me/${tgUser}`;
  const noticeHighlight = username
    ? (lang === 'en' ? `@${esc(username)} in Telegram:` : `@${esc(username)} в Telegram:`)
    : (lang === 'en' ? 'Telegram Bot:' : 'Телеграм-бот Threads:');
  const noticeMsg = username
    ? (lang === 'en' ? 'Read this profile, view media and get real-time notifications for new posts without VPN.' : 'Читайте этот профиль, смотрите медиа и получайте уведомления о новых публикациях без VPN.')
    : (lang === 'en' ? 'Browse Threads profiles without VPN, save favorites and receive instant post updates.' : 'Читайте любые треды без VPN, сохраняйте авторов и получайте уведомления о новых постах.');
  const btnLabel = username
    ? (lang === 'en' ? `Open @${esc(username)} in Telegram` : `Читать @${esc(username)} в Telegram`)
    : (lang === 'en' ? 'Open in Telegram' : 'Открыть в Telegram');

  return `
    <div class="notice-bar">
      <span><strong class="notice-bar-highlight">${noticeHighlight}</strong> ${noticeMsg}</span>
      <a href="${esc(tgLink)}" target="_blank" rel="noopener">${btnLabel}</a>
    </div>
  `;
}

function renderSponsorSlot(env: Env, lang: Lang, isPremium = false, country = ""): string {
  if (isPremium) return "";
  const cisCountries = ["RU", "BY", "KZ", "UA", "KG", "UZ", "TJ", "AM", "AZ", "MD"];
  const isCis = cisCountries.includes(country.toUpperCase()) || (!country && lang === "ru");
  const tgUser = getBotUsername(env);

  let sponsorUrl = "";
  let sponsorTag = "";
  let sponsorAdLabel = "";
  let sponsorTitle = "";
  let sponsorDesc = "";
  let sponsorBtn = "";

  if (isCis) {
    sponsorUrl = env.SPONSOR_RU_URL || `https://t.me/${esc(tgUser)}`;
    sponsorTag = "Партнерский блок";
    sponsorAdLabel = "Реклама";
    sponsorTitle = env.SPONSOR_RU_TITLE || "Быстрый VPN и приватный доступ без ограничений";
    sponsorDesc = env.SPONSOR_RU_DESC || "Выделенные серверы для РФ и Беларуси. Мгновенная работа Threads, Reels и Twitter без лагов.";
    sponsorBtn = "Подключить";
  } else {
    sponsorUrl = env.SPONSOR_EN_URL || `https://t.me/${esc(tgUser)}`;
    sponsorTag = "Sponsored";
    sponsorAdLabel = "Ad";
    sponsorTitle = env.SPONSOR_EN_TITLE || "Anonymous Social Feed Proxy and Fast VPN";
    sponsorDesc = env.SPONSOR_EN_DESC || "High-speed encrypted connection. Browse Threads and social platforms without tracking.";
    sponsorBtn = "Learn more";
  }

  const adFreeUrl = `https://t.me/${esc(tgUser)}?start=web_adfree`;
  const adFreeText = lang === "en" ? "Disable ads" : "Отключить рекламу";

  return `
    <div class="sponsor-card">
      <div class="sponsor-card-top">
        <span>${sponsorTag}</span>
        <div style="display:inline-flex;align-items:center;gap:8px;">
          <a href="${esc(sponsorUrl)}" target="_blank" rel="noopener" style="color: #777; text-decoration: underline;">${sponsorAdLabel}</a>
          <a href="/pay?plan=7" class="ad-free-link" style="color:#60a5fa;font-weight:700;" title="${lang === 'en' ? 'Disable ads with online card/SBP payment' : 'Отключить рекламу онлайн через СБП/Карту'}">💳 ${lang === 'en' ? 'Disable ads ($0.99)' : 'Отключить рекламу (99 ₽)'}</a>
          <a href="${esc(adFreeUrl)}" target="_blank" rel="noopener" class="ad-free-link" title="${lang === 'en' ? 'Get ad-free browsing with Telegram bot' : 'Отключить рекламу через Telegram-бота'}">Telegram</a>
        </div>
      </div>
      <div class="sponsor-card-inner">
        <div class="sponsor-text">
          <h4>${esc(sponsorTitle)}</h4>
          <p>${esc(sponsorDesc)}</p>
        </div>
        <a href="${esc(sponsorUrl)}" target="_blank" rel="noopener" class="sponsor-btn">
          ${esc(sponsorBtn)}
        </a>
      </div>
    </div>
  `;
}

export function renderSupportCard(lang: Lang): string {
  const t = I18N[lang];
  return `
    <div class="support-card" id="supportSection">
      <div class="support-title">${t.support_title}</div>
      <div class="support-desc">${t.support_desc}</div>
      <form id="supportForm" onsubmit="handleSupportSubmit(event)">
        <div class="support-field">
          <label class="support-label" for="supportContact">${t.support_contact_label}</label>
          <input type="text" id="supportContact" class="support-input" placeholder="${t.support_contact_placeholder}" maxlength="100" />
        </div>
        <div class="support-field">
          <label class="support-label" for="supportMessage">${t.support_message_label}</label>
          <textarea id="supportMessage" class="support-textarea" rows="3" placeholder="${t.support_message_placeholder}" maxlength="2000" required></textarea>
        </div>
        <button type="submit" id="supportSubmitBtn" class="support-btn">${t.support_submit}</button>
        <div id="supportFeedback" class="support-feedback" style="display:none;"></div>
      </form>
    </div>
  `;
}

export function renderCookieBanner(lang: Lang = "ru"): string {
  const isEn = lang === "en";
  const text = isEn
    ? `We use technical cookies to ensure site functionality and save your preferences. By continuing to use the service, you agree to our <a href="/privacy?lang=en" class="cookie-policy-link">Privacy Policy</a>.`
    : `Мы используем технические файлы cookie для корректной работы сайта и сохранения настроек. Продолжая использовать сервис, вы соглашаетесь с <a href="/privacy?lang=ru" class="cookie-policy-link">Политикой обработки данных</a>.`;
  const btn = isEn ? "Accept" : "Понятно";

  return `
    <div id="cookieBanner" class="cookie-banner" style="display:none;">
      <div class="cookie-banner-text">${text}</div>
      <button type="button" class="cookie-banner-btn" onclick="acceptCookies()">${btn}</button>
    </div>
    <script>
      (function checkCookieConsent(){
        try {
          if (localStorage.getItem('threads_cookie_ack') === '1') return;
          var b = document.getElementById('cookieBanner');
          if (b) b.style.display = 'flex';
        } catch(e){}
      })();
      function acceptCookies(){
        try { localStorage.setItem('threads_cookie_ack', '1'); } catch(e){}
        var b = document.getElementById('cookieBanner');
        if (b) b.style.display = 'none';
      }
    </script>
  `;
}

export function renderHomePage(
  env: Env,
  lang: Lang = "ru",
  isPremium = false,
  country = "",
  origin = env.SITE_URL || "https://threadsviewer.online",
  paymentStatus: "success" | "fail" | null = null
): Response {
  const t = I18N[lang];
  const tgUser = getBotUsername(env);
  const homeCanonical = `${origin}/${lang === 'en' ? '?lang=en' : ''}`;
  const ver = env.VERSION || "pr35-2026-09-22-ux";

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>${t.home_title}</title>
  <meta name="description" content="${t.home_desc}">
  <meta name="keywords" content="${esc(t.keywords)}">
  <meta name="yandex-verification" content="f2e3a97ba3ea12b6">
  <meta name="google-site-verification" content="cgAMWfV193QZiRMRVEtwzGA4JFcCR6sfixu2ws2TLBg">
  <meta name="google-site-verification" content="google3ae2b24cd673c270">
  <meta name="verification" content="7d97667a3e056acab9aaf653807b4a03">
  <link rel="canonical" href="${homeCanonical}">
  <link rel="alternate" hreflang="ru" href="${origin}/ru/">
  <link rel="alternate" hreflang="en" href="${origin}/en/">
  <link rel="alternate" hreflang="x-default" href="${origin}/">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=${esc(ver)}">
  <link rel="alternate icon" href="/favicon.ico?v=${esc(ver)}">
  <link rel="apple-touch-icon" href="/favicon.svg?v=${esc(ver)}">
  <meta property="og:site_name" content="Threads Viewer">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${esc(t.home_title)}">
  <meta property="og:description" content="${esc(t.home_desc)}">
  <meta property="og:url" content="${homeCanonical}">
  <meta property="og:image" content="${origin}/og-image.svg?v=${esc(ver)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${esc(t.home_title)}">
  <meta name="twitter:description" content="${esc(t.home_desc)}">
  <meta name="twitter:image" content="${origin}/og-image.svg?v=${esc(ver)}">
  <script type="application/ld+json">
  [
    {
      "@context": "https://schema.org",
      "@type": "WebSite",
      "name": "Threads Viewer",
      "url": "${origin}/",
      "description": "${esc(t.home_desc)}",
      "potentialAction": {
        "@type": "SearchAction",
        "target": "${origin}/@{search_term_string}",
        "query-input": "required name=search_term_string"
      }
    },
    {
      "@context": "https://schema.org",
      "@type": "FAQPage",
      "mainEntity": [
        {
          "@type": "Question",
          "name": "${esc(t.faq_q1)}",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "${esc(t.faq_a1)}"
          }
        },
        {
          "@type": "Question",
          "name": "${esc(t.faq_q2)}",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "${esc(t.faq_a2)}"
          }
        },
        {
          "@type": "Question",
          "name": "${esc(t.faq_q3)}",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "${esc(t.faq_a3)}"
          }
        },
        {
          "@type": "Question",
          "name": "${esc(t.faq_q4)}",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "${esc(t.faq_a4)}"
          }
        },
        {
          "@type": "Question",
          "name": "${esc(t.faq_q5)}",
          "acceptedAnswer": {
            "@type": "Answer",
            "text": "${esc(t.faq_a5)}"
          }
        }
      ]
    }
  ]
  </script>
  <script>
    (function(){
      var t = localStorage.getItem('threads_theme');
      if (t === 'light' || (!t && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)) {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    })();
  </script>
  <style>${COMMON_STYLES}</style>
</head>
<body>
  ${renderNavbar(env, lang, "", isPremium)}
  ${renderNoticeBar(env, lang, undefined, isPremium)}

  <main class="container">
    ${paymentStatus === 'success' ? `
    <div style="background:#132818;border:1px solid #22c55e;color:#86efac;padding:14px 18px;margin-bottom:20px;font-size:0.95rem;font-weight:600;">
      ${lang === 'en' ? 'Payment completed successfully! Thank you for supporting the service.' : 'Оплата успешно завершена! Спасибо за поддержку сервиса.'}
    </div>` : (paymentStatus === 'fail' ? `
    <div style="background:#281313;border:1px solid #ef4444;color:#fca5a5;padding:14px 18px;margin-bottom:20px;font-size:0.95rem;font-weight:600;">
      ${lang === 'en' ? 'Payment was cancelled or failed. If you need help, please contact support.' : 'Оплата была отменена или не удалась. Если возникли трудности, обратитесь в поддержку.'}
    </div>` : '')}
    <div class="hero-card">
      <div class="hero-tag">${t.hero_tag}</div>
      <h1 class="hero-title">${t.hero_title}</h1>
      <p class="hero-subtitle">${t.hero_subtitle}</p>

      <form class="hero-search-form" onsubmit="handleHeroSearch(event)">
        <input type="text" id="heroSearchInput" placeholder="${t.hero_search_placeholder}" autofocus />
        <button type="submit">${t.open_btn}</button>
      </form>

      <div class="example-hint">
        ${t.example_hint}
      </div>

      <div class="tg-callout-card">
        <div class="tg-callout-left">
          <div class="tg-callout-badge">${t.tg_badge}</div>
          <div class="tg-callout-title">${t.tg_card_title}</div>
          <div class="tg-callout-desc">${t.tg_card_desc}</div>
        </div>
        <a href="https://t.me/${esc(tgUser)}" target="_blank" rel="noopener" class="tg-callout-btn">${t.tg_card_btn}</a>
      </div>

      <div class="popular-section">
        <div class="popular-header">
          <span class="popular-title">${t.popular_creators_title}</span>
        </div>
        <div class="popular-list">
          ${POPULAR_CREATORS.map(c => `
            <a href="/@${c.username}${lang === 'en' ? '?lang=en' : ''}" class="creator-chip">
              <span class="creator-chip-at">@</span>
              <span class="creator-chip-name">${c.username}</span>
              <span class="creator-chip-desc">${lang === 'en' ? c.label_en : c.label_ru}</span>
            </a>
          `).join('')}
        </div>
      </div>

      <div id="favoritesSection" class="history-section" style="display:none;margin-top:18px;">
        <div class="history-header">
          <span class="history-title">${t.favorites_title}</span>
        </div>
        <div id="favoritesList" class="history-list"></div>
      </div>

      <div id="recentHistorySection" class="history-section" style="display:none;">
        <div class="history-header">
          <span class="history-title">${t.recent_profiles_title}</span>
          <button type="button" class="history-clear-btn" onclick="clearBrowsingHistory()">${t.clear_history}</button>
        </div>
        <div id="recentHistoryList" class="history-list"></div>
      </div>
    </div>

    ${renderSponsorSlot(env, lang, isPremium, country)}

    <div class="faq-card">
      <h2 class="faq-main-title">${t.faq_main_title}</h2>
      <div class="faq-list">
        <details class="faq-item" open>
          <summary class="faq-question">${t.faq_q1}</summary>
          <div class="faq-answer">${t.faq_a1}</div>
        </details>
        <details class="faq-item">
          <summary class="faq-question">${t.faq_q2}</summary>
          <div class="faq-answer">${t.faq_a2}</div>
        </details>
        <details class="faq-item">
          <summary class="faq-question">${t.faq_q3}</summary>
          <div class="faq-answer">${t.faq_a3}</div>
        </details>
        <details class="faq-item">
          <summary class="faq-question">${t.faq_q4}</summary>
          <div class="faq-answer">${t.faq_a4}</div>
        </details>
        <details class="faq-item">
          <summary class="faq-question">${t.faq_q5}</summary>
          <div class="faq-answer">${t.faq_a5}</div>
        </details>
      </div>
    </div>

    ${renderSupportCard(lang)}
  </main>

  <footer class="footer-block">
    <div class="footer-links-row">
      <a href="/?lang=${lang}">Главная</a>
      <a href="https://t.me/${esc(tgUser)}" target="_blank" rel="noopener">${t.bot_link_text}</a>
      <a href="/terms?lang=${lang}">${t.tos}</a>
      <a href="/privacy?lang=${lang}">${t.privacy}</a>
    </div>
    <p>${t.footer_text}</p>
  </footer>

  <div id="toast" class="toast-box"></div>

  <script>
    var currentLang = "${lang}";
    function setLangCookie(code) {
      document.cookie = "lang=" + code + ";path=/;max-age=31536000";
    }
    function fillSearch(val) {
      var input = document.getElementById('heroSearchInput');
      if (input) {
        input.value = val;
        input.focus();
      }
    }
    function showToast(msg) {
      var t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(function() { t.style.display = 'none'; }, 2200);
    }
    function parseInput(raw) {
      var clean = (raw || '').trim();
      var postRegex = new RegExp('(?:threads\\\\.(?:com|net)/)?@?([A-Za-z0-9._]+)/post/([A-Za-z0-9._-]+)', 'i');
      var postMatch = clean.match(postRegex);
      if (postMatch) {
        return { username: postMatch[1], postId: postMatch[2] };
      }
      var userRegex = new RegExp('(?:threads\\\\.(?:com|net)/)?@?([A-Za-z0-9._]+)', 'i');
      var userMatch = clean.match(userRegex);
      return userMatch ? { username: userMatch[1], postId: null } : null;
    }
    function cleanUsername(raw) {
      var p = parseInput(raw);
      return p ? p.username : '';
    }
    function handleHeroSearch(e) {
      e.preventDefault();
      var input = document.getElementById('heroSearchInput');
      var parsed = parseInput(input.value);
      if (parsed) {
        if (parsed.postId) {
          window.location.href = '/@' + encodeURIComponent(parsed.username) + '/post/' + encodeURIComponent(parsed.postId) + (currentLang === 'en' ? '?lang=en' : '');
        } else {
          window.location.href = '/@' + encodeURIComponent(parsed.username) + (currentLang === 'en' ? '?lang=en' : '');
        }
      } else {
        showToast('${t.toast_invalid_username}');
      }
    }
    function handleNavSearch(e) {
      e.preventDefault();
      var input = document.getElementById('navSearchInput');
      var parsed = parseInput(input.value);
      if (parsed) {
        if (parsed.postId) {
          window.location.href = '/@' + encodeURIComponent(parsed.username) + '/post/' + encodeURIComponent(parsed.postId) + (currentLang === 'en' ? '?lang=en' : '');
        } else {
          window.location.href = '/@' + encodeURIComponent(parsed.username) + (currentLang === 'en' ? '?lang=en' : '');
        }
      }
    }
    function toggleTheme() {
      var isLight = document.documentElement.getAttribute('data-theme') === 'light';
      if (isLight) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('threads_theme', 'dark');
      } else {
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('threads_theme', 'light');
      }
      updateThemeBtnText();
    }
    function updateThemeBtnText() {
      var el = document.getElementById('themeToggleText');
      if (!el) return;
      var isLight = document.documentElement.getAttribute('data-theme') === 'light';
      var isEn = currentLang === 'en';
      if (isEn) {
        el.innerText = isLight ? 'Dark' : 'Light';
      } else {
        el.innerText = isLight ? 'Темная' : 'Светлая';
      }
    }
    function loadFavorites() {
      try {
        var raw = localStorage.getItem('threads_favorites');
        if (!raw) return;
        var list = JSON.parse(raw);
        if (!Array.isArray(list) || !list.length) return;
        var sec = document.getElementById('favoritesSection');
        var container = document.getElementById('favoritesList');
        if (!sec || !container) return;
        container.innerHTML = list.map(function(item) {
          var u = (typeof item === 'string' ? item : (item.username || '')).replace(/^@/, '');
          return '<a href="/@' + encodeURIComponent(u) + (currentLang === 'en' ? '?lang=en' : '') + '" class="history-chip">' +
            '<span class="history-chip-avatar">[@]</span>' +
            '<span class="history-chip-name">@' + escHtml(u) + '</span>' +
          '</a>';
        }).join('');
        sec.style.display = 'block';
      } catch (e) {}
    }
    function loadBrowsingHistory() {
      try {
        var raw = localStorage.getItem('threads_history');
        if (!raw) return;
        var list = JSON.parse(raw);
        if (!Array.isArray(list) || !list.length) return;
        var sec = document.getElementById('recentHistorySection');
        var container = document.getElementById('recentHistoryList');
        if (!sec || !container) return;
        container.innerHTML = list.map(function(item) {
          var u = (item.username || '').replace(/^@/, '');
          return '<a href="/@' + encodeURIComponent(u) + (currentLang === 'en' ? '?lang=en' : '') + '" class="history-chip">' +
            '<span class="history-chip-avatar">@</span>' +
            '<span class="history-chip-name">@' + escHtml(u) + '</span>' +
          '</a>';
        }).join('');
        sec.style.display = 'block';
      } catch (e) {}
    }
    function clearBrowsingHistory() {
      try {
        localStorage.removeItem('threads_history');
        var sec = document.getElementById('recentHistorySection');
        if (sec) sec.style.display = 'none';
      } catch (e) {}
    }
    function escHtml(str) {
      return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function handleSupportSubmit(e) {
      e.preventDefault();
      var btn = document.getElementById('supportSubmitBtn');
      var fb = document.getElementById('supportFeedback');
      var contactEl = document.getElementById('supportContact');
      var msgEl = document.getElementById('supportMessage');
      if (!btn || !msgEl) return;
      var message = msgEl.value.trim();
      var contact = contactEl ? contactEl.value.trim() : '';
      if (!message) return;

      var sendingText = currentLang === 'en' ? 'Sending...' : 'Отправка...';
      var successText = currentLang === 'en' ? 'Thank you! Your message has been sent to the admin.' : 'Спасибо! Ваше сообщение отправлено администратору.';
      var errorText = currentLang === 'en' ? 'Failed to send message. Please try again later.' : 'Не удалось отправить сообщение. Пожалуйста, попробуйте позже.';
      var origBtnText = btn.innerText;

      btn.disabled = true;
      btn.innerText = sendingText;
      if (fb) {
        fb.style.display = 'none';
        fb.className = 'support-feedback';
      }

      fetch('/api/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact: contact,
          message: message,
          path: window.location.pathname
        })
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        btn.disabled = false;
        btn.innerText = origBtnText;
        if (fb) {
          fb.style.display = 'block';
          if (data && data.ok) {
            fb.className = 'support-feedback success';
            fb.innerText = successText;
            msgEl.value = '';
            if (contactEl) contactEl.value = '';
          } else {
            fb.className = 'support-feedback error';
            fb.innerText = (data && data.error) || errorText;
          }
        }
      })
      .catch(function() {
        btn.disabled = false;
        btn.innerText = origBtnText;
        if (fb) {
          fb.style.display = 'block';
          fb.className = 'support-feedback error';
          fb.innerText = errorText;
        }
      });
    }

    document.addEventListener('DOMContentLoaded', function() {
      updateThemeBtnText();
      loadFavorites();
      loadBrowsingHistory();
    });
    updateThemeBtnText();
    loadFavorites();
    loadBrowsingHistory();
  </script>
  ${renderCookieBanner(lang)}
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "public, max-age=3600",
    },
  });
}

export function renderProfilePage(
  env: Env,
  username: string,
  initialData?: ProfileData | null,
  errorMessage?: string | null,
  lang: Lang = "ru",
  isPremium = false,
  country = "",
  targetPostId?: string,
  origin = env.SITE_URL || "https://threadsviewer.online"
): Response {
  const t = I18N[lang];
  const tgUser = getBotUsername(env);
  const cleanUser = username.replace(/^@/, "").toLowerCase();
  const profile = initialData?.profile || {
    username: cleanUser,
    displayName: cleanUser,
    bio: "",
    avatar: "",
    followers: "",
    verified: false,
  };
  const posts = initialData?.posts || [];
  const hasData = Boolean(initialData && (initialData.profile || posts.length > 0));

  const targetPost = targetPostId
    ? (posts.find((p, i) => (p.id && String(p.id) === targetPostId) || String(i) === targetPostId) || null)
    : null;

  const postsHtml = posts.length > 0
    ? posts.map((post, idx) => {
    const postDate = formatDisplayDate(post.date || "");
    const authorName = post.author || profile.displayName || cleanUser;
    const authorAvatar = post.authorAvatar || profile.avatar || "";
    const isHighlighted = targetPost && (post === targetPost || String(idx) === targetPostId || (post.id && String(post.id) === targetPostId));
    const postIdentifier = post.id || idx;

    const videoHtml = post.videoUrl
      ? `<div class="post-media-box">
          <video src="/api/media?url=${encodeURIComponent(post.videoUrl)}" data-orig="${esc(safeMediaUrl(post.videoUrl))}" controls playsinline preload="metadata" poster="${esc(safeMediaUrl(post.imageUrl || ''))}" onerror="handleVideoError(this)">
            Ваш браузер не поддерживает видео.
          </video>
        </div>`
      : "";

    const mediaHtml = videoHtml || (post.imageUrl
      ? `<div class="post-media-box">
          <img src="${esc(safeMediaUrl(post.imageUrl))}" data-orig="${esc(safeMediaUrl(post.imageUrl))}" alt="Post image" referrerpolicy="no-referrer" onclick="openLightbox(this.src)" onerror="handleImgError(this)" />
        </div>`
      : "");

    const videoMarker = (post.has_video && !post.videoUrl)
      ? `<span class="video-indicator">${t.video}</span>`
      : "";

    return `
      <article class="post-card ${isHighlighted ? 'post-highlighted' : ''}" id="post-${postIdentifier}">
        <div class="post-card-top">
          <div class="post-author-block">
            ${authorAvatar ? `<img src="${esc(safeMediaUrl(authorAvatar))}" data-orig="${esc(safeMediaUrl(authorAvatar))}" class="post-author-avatar" alt="${esc(authorName)}" referrerpolicy="no-referrer" onerror="handleImgError(this)" />` : `<div class="post-author-avatar" style="display:flex;align-items:center;justify-content:center;color:#666;font-size:11px;">@</div>`}
            <div>
              <a href="/@${esc(cleanUser)}${lang === 'en' ? '?lang=en' : ''}" class="post-author-handle">${esc(authorName)}</a>
              ${postDate ? `<div class="post-timestamp">${esc(postDate)}</div>` : ""}
            </div>
          </div>
          <button class="toolbar-btn" title="${t.share_post}" onclick="copyPostLink(${idx}, '${esc(postIdentifier)}')">
            ${t.share_post}
          </button>
        </div>

        <div class="post-body-text">
          ${formatPostText(post.text)}
        </div>

        ${videoMarker}
        ${mediaHtml}

        <div class="post-toolbar">
          <span class="post-metric" title="${t.like}">
            <span class="post-metric-icon">&#9825;</span>
            <span class="post-metric-label">${t.like}:</span>
            <span class="post-metric-val">${post.likes ? esc(post.likes) : "0"}</span>
          </span>
          <button class="toolbar-btn comment-btn" onclick="toggleComments(${idx}, this)" title="${t.comments}">
            <span class="comment-label">${t.comments}</span>
            <span class="comment-count">${post.replies ? ` (${esc(post.replies)})` : ""}</span>
          </button>
          <a href="https://t.me/${esc(tgUser)}?start=sub_${esc(cleanUser)}" target="_blank" rel="noopener" class="toolbar-btn" style="margin-left:auto;">
            ${t.in_bot}
          </a>
        </div>

        <div class="comments-box" id="comments-${idx}"></div>
      </article>
    `;
  }).join("")
    : (hasData ? `<div class="status-card" style="text-align:center;padding:24px 16px;"><p style="color:#777;">${lang === 'en' ? 'No posts in this profile yet.' : 'В этом профиле пока нет постов.'}</p></div>` : "");

  const snippet = targetPost ? (targetPost.text ? targetPost.text.slice(0, 140).trim() : (lang === "en" ? "Post with media" : "Пост с медиа")) : "";
  const pageTitle = targetPost
    ? `@${esc(cleanUser)} в Threads: "${esc(snippet)}" | Threads Viewer`
    : `@${esc(cleanUser)} в Threads - читать без VPN | Threads Viewer`;
  const ogTitle = targetPost ? `@${esc(cleanUser)}: "${esc(snippet)}"` : `@${esc(cleanUser)} в Threads без VPN`;
  const ogDesc = esc(targetPost ? (targetPost.text ? targetPost.text.slice(0, 240) : `Пост @${cleanUser} в Threads`) : (profile.bio ? profile.bio.slice(0, 220) : `Посты, фото и комментарии @${cleanUser} в Threads без регистрации и VPN.`));
  const rawMedia = targetPost ? (targetPost.imageUrl || profile.avatar) : profile.avatar;
  const ogImage = rawMedia ? `${origin}/api/img?url=${encodeURIComponent(rawMedia)}` : "";
  const canonicalUrl = targetPostId ? `${origin}/@${esc(cleanUser)}/post/${esc(targetPostId)}` : `${origin}/@${esc(cleanUser)}`;

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>${pageTitle}</title>
  <meta name="description" content="${ogDesc}">
  <meta name="keywords" content="${esc(cleanUser)}, @${esc(cleanUser)}, threads, тредс, читать threads без впн, смотреть профиль ${esc(cleanUser)}">
  <meta name="yandex-verification" content="f2e3a97ba3ea12b6">
  <meta name="google-site-verification" content="cgAMWfV193QZiRMRVEtwzGA4JFcCR6sfixu2ws2TLBg">
  <meta name="google-site-verification" content="google3ae2b24cd673c270">
  <meta name="verification" content="7d97667a3e056acab9aaf653807b4a03">
  <link rel="canonical" href="${canonicalUrl}">
  <link rel="alternate" hreflang="ru" href="${origin}/@${esc(cleanUser)}">
  <link rel="alternate" hreflang="en" href="${origin}/@${esc(cleanUser)}?lang=en">
  <link rel="alternate" hreflang="x-default" href="${origin}/@${esc(cleanUser)}">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg?v=${esc(env.VERSION || 'pr35-2026-09-22-ux')}">
  <link rel="alternate icon" href="/favicon.ico?v=${esc(env.VERSION || 'pr35-2026-09-22-ux')}">
  <link rel="apple-touch-icon" href="/favicon.svg?v=${esc(env.VERSION || 'pr35-2026-09-22-ux')}">
  <meta property="og:site_name" content="Threads Viewer">
  <meta property="og:type" content="${targetPost ? 'article' : 'profile'}">
  <meta property="og:title" content="${esc(ogTitle)}">
  <meta property="og:description" content="${ogDesc}">
  <meta property="og:url" content="${canonicalUrl}">
  ${ogImage ? `<meta property="og:image" content="${esc(ogImage)}">` : ''}
  <meta name="twitter:card" content="${ogImage ? 'summary_large_image' : 'summary'}">
  <meta name="twitter:title" content="${esc(ogTitle)}">
  <meta name="twitter:description" content="${ogDesc}">
  ${ogImage ? `<meta name="twitter:image" content="${esc(ogImage)}">` : ''}
  <script type="application/ld+json">
  {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "ProfilePage",
        "name": "@${esc(cleanUser)} in Threads",
        "url": "${canonicalUrl}",
        "description": "${esc(ogDesc)}",
        "mainEntity": {
          "@type": "Person",
          "name": "${esc(profile.displayName || cleanUser)}",
          "alternateName": "@${esc(cleanUser)}",
          "identifier": "${esc(cleanUser)}",
          "image": "${esc(profile.avatar || '')}",
          "description": "${esc(profile.bio || '')}"
        }
      },
      {
        "@type": "BreadcrumbList",
        "itemListElement": [
          {
            "@type": "ListItem",
            "position": 1,
            "name": "Threads Viewer",
            "item": "${origin}/"
          },
          {
            "@type": "ListItem",
            "position": 2,
            "name": "@${esc(cleanUser)}",
            "item": "${canonicalUrl}"
          }
        ]
      }
    ]
  }
  </script>
  <script>
    (function(){
      var t = localStorage.getItem('threads_theme');
      if (t === 'light' || (!t && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)) {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    })();
    function handleImgError(el) {
      if (!el.dataset.proxied) {
        el.dataset.proxied = '1';
        el.src = '/api/img?url=' + encodeURIComponent(el.dataset.orig || el.src);
      } else {
        el.style.display = 'none';
      }
    }
    function handleVideoError(el) {
      if (!el.dataset.failed && el.dataset.orig) {
        el.dataset.failed = '1';
        el.src = el.dataset.orig;
      }
    }
  </script>
  <style>${COMMON_STYLES}</style>
</head>
<body>
  ${renderNavbar(env, lang, "@" + cleanUser, isPremium)}
  ${renderNoticeBar(env, lang, cleanUser, isPremium)}

  <main class="container">
    <div class="profile-card">
      <div class="profile-top-row">
        <div class="profile-title-block">
          <h1 class="profile-name">${esc(profile.displayName)}</h1>
          <div class="profile-handle">@${esc(cleanUser)} (threads.com)</div>
        </div>
        <div class="profile-avatar-box">
          ${profile.avatar
            ? `<img src="${esc(safeMediaUrl(profile.avatar))}" data-orig="${esc(safeMediaUrl(profile.avatar))}" class="profile-avatar-img" alt="${esc(cleanUser)}" referrerpolicy="no-referrer" onerror="handleImgError(this)" />`
            : `<div class="profile-avatar-img" style="display:flex;align-items:center;justify-content:center;color:#666;font-size:24px;">@</div>`}
        </div>
      </div>

      ${profile.bio ? `<div class="profile-bio">${formatPostText(profile.bio)}</div>` : ""}

      <div class="profile-stats-row">
        ${profile.followers ? `<span>${t.followers_label}: ${esc(profile.followers)}</span>` : ""}
        <span>${t.no_vpn_label}</span>
        <span>${t.anon_label}</span>
      </div>

      <div class="profile-actions">
        <a href="https://t.me/${esc(tgUser)}?start=sub_${esc(cleanUser)}" target="_blank" rel="noopener" class="btn-sharp btn-sharp-tg">
          ${t.sub_tg}
        </a>
        <button class="btn-sharp" id="favToggleBtn" onclick="toggleFavorite('${esc(cleanUser)}')">
          <span id="favBtnLabel">[+] ${t.favorite_add}</span>
        </button>
        <a href="https://t.me/${esc(tgUser)}?start=track_${esc(cleanUser)}" target="_blank" rel="noopener" class="btn-sharp">
          ${t.track_in_bot}
        </a>
        <button class="btn-sharp" onclick="shareProfile()">
          ${t.share_profile}
        </button>
      </div>
    </div>

    ${renderSponsorSlot(env, lang, isPremium, country)}

    <section class="feed" id="postsFeed">
      ${postsHtml}
    </section>

    <div id="loadingBox" class="status-card ${errorMessage ? 'status-card-error' : 'status-card-loading'}" style="${hasData ? "display:none;" : ""}">
      <div class="status-card-header">
        <span class="status-indicator-box"></span>
        <h3 id="loadingStatusTitle">${errorMessage ? (lang === 'en' ? 'Profile Not Found or Error' : 'Профиль не найден или ошибка') : t.loading_posts}</h3>
      </div>
      <p id="loadingStatusText">${errorMessage ? esc(errorMessage) : (lang === 'en' ? 'Fetching profile, posts and media from Threads servers. This may take a few seconds...' : 'Запрашиваем профиль, посты и медиа с серверов Threads. Это занимает несколько секунд...')}</p>
      <div id="loadingStatusAction" style="${errorMessage ? 'margin-top:14px;' : 'display:none;margin-top:14px;'}">
        <a href="/?lang=${lang}" class="btn-sharp" style="display:inline-block;">${lang === 'en' ? 'Back to Home' : 'Вернуться на главную'}</a>
      </div>
    </div>

    <div style="text-align: center; margin: 20px 0;" id="loadMoreSection" style="${hasData ? "" : "display:none;"}">
      <button class="btn-sharp" style="width: 100%; max-width: 260px; justify-content: center;" onclick="loadMorePosts('${esc(cleanUser)}')">
        ${t.load_more}
      </button>
    </div>

    ${renderSupportCard(lang)}
  </main>

  <div id="lightbox" class="lightbox-overlay" onclick="closeLightbox()">
    <button class="lightbox-close-btn" onclick="closeLightbox()">&times;</button>
    <img id="lightboxImg" src="" alt="View image" />
  </div>

  <div id="toast" class="toast-box"></div>

  <footer class="footer-block">
    <div class="footer-links-row">
      <a href="/?lang=${lang}">Главная</a>
      <a href="https://t.me/${esc(tgUser)}" target="_blank" rel="noopener">${t.bot_link_text}</a>
      <a href="/terms?lang=${lang}">${t.tos}</a>
      <a href="/privacy?lang=${lang}">${t.privacy}</a>
    </div>
    <p>${t.footer_text}</p>
  </footer>

  <script>
    var currentUsername = "${esc(cleanUser)}";
    var currentLang = "${lang}";
    var isLoaded = ${hasData ? "true" : "false"};

    (function recordProfileHistory() {
      try {
        var raw = localStorage.getItem('threads_history');
        var list = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(list)) list = [];
        list = list.filter(function(item) {
          return item && item.username && item.username.toLowerCase() !== currentUsername.toLowerCase();
        });
        list.unshift({
          username: currentUsername,
          time: Date.now()
        });
        if (list.length > 12) list = list.slice(0, 12);
        localStorage.setItem('threads_history', JSON.stringify(list));
      } catch (e) {}
    })();

    function setLangCookie(code) {
      document.cookie = "lang=" + code + ";path=/;max-age=31536000";
    }

    function handleSupportSubmit(e) {
      e.preventDefault();
      var btn = document.getElementById('supportSubmitBtn');
      var fb = document.getElementById('supportFeedback');
      var contactEl = document.getElementById('supportContact');
      var msgEl = document.getElementById('supportMessage');
      if (!btn || !msgEl) return;
      var message = msgEl.value.trim();
      var contact = contactEl ? contactEl.value.trim() : '';
      if (!message) return;

      var sendingText = currentLang === 'en' ? 'Sending...' : 'Отправка...';
      var successText = currentLang === 'en' ? 'Thank you! Your message has been sent to the admin.' : 'Спасибо! Ваше сообщение отправлено администратору.';
      var errorText = currentLang === 'en' ? 'Failed to send message. Please try again later.' : 'Не удалось отправить сообщение. Пожалуйста, попробуйте позже.';
      var origBtnText = btn.innerText;

      btn.disabled = true;
      btn.innerText = sendingText;
      if (fb) {
        fb.style.display = 'none';
        fb.className = 'support-feedback';
      }

      fetch('/api/support', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contact: contact,
          message: message,
          path: window.location.pathname
        })
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        btn.disabled = false;
        btn.innerText = origBtnText;
        if (fb) {
          fb.style.display = 'block';
          if (data && data.ok) {
            fb.className = 'support-feedback success';
            fb.innerText = successText;
            msgEl.value = '';
            if (contactEl) contactEl.value = '';
          } else {
            fb.className = 'support-feedback error';
            fb.innerText = (data && data.error) || errorText;
          }
        }
      })
      .catch(function() {
        btn.disabled = false;
        btn.innerText = origBtnText;
        if (fb) {
          fb.style.display = 'block';
          fb.className = 'support-feedback error';
          fb.innerText = errorText;
        }
      });
    }

    function showToast(msg) {
      var t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(function() { t.style.display = 'none'; }, 2000);
    }

    function shareProfile() {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(window.location.href);
        showToast('${t.toast_profile_copied}');
      } else {
        showToast(window.location.href);
      }
    }

    function copyPostLink(idx, identifier) {
      var id = identifier !== undefined ? identifier : idx;
      var url = window.location.origin + '/@' + currentUsername + '/post/' + id;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url);
        showToast('${t.toast_post_copied}');
      } else {
        showToast(url);
      }
    }

    function checkFavoriteStatus() {
      try {
        var raw = localStorage.getItem('threads_favorites');
        var list = raw ? JSON.parse(raw) : [];
        var isFav = Array.isArray(list) && list.some(function(item) {
          var u = typeof item === 'string' ? item : (item.username || '');
          return u.toLowerCase() === currentUsername.toLowerCase();
        });
        var lbl = document.getElementById('favBtnLabel');
        if (lbl) {
          lbl.innerText = isFav ? ('[-] ' + (currentLang === 'en' ? 'Bookmarked' : 'В закладках')) : ('[+] ' + (currentLang === 'en' ? 'Bookmark' : 'В закладки'));
        }
      } catch (e) {}
    }

    function toggleFavorite(username) {
      try {
        var raw = localStorage.getItem('threads_favorites');
        var list = raw ? JSON.parse(raw) : [];
        if (!Array.isArray(list)) list = [];
        var clean = (username || currentUsername).toLowerCase();
        var idx = -1;
        for (var i = 0; i < list.length; i++) {
          var u = typeof list[i] === 'string' ? list[i] : (list[i].username || '');
          if (u.toLowerCase() === clean) { idx = i; break; }
        }
        if (idx >= 0) {
          list.splice(idx, 1);
          showToast(currentLang === 'en' ? 'Removed from bookmarks' : 'Удалено из закладок');
        } else {
          list.unshift({ username: clean, time: Date.now() });
          showToast(currentLang === 'en' ? 'Added to bookmarks' : 'Добавлено в закладки');
        }
        localStorage.setItem('threads_favorites', JSON.stringify(list));
        checkFavoriteStatus();
      } catch (e) {}
    }

    function openLightbox(src) {
      var box = document.getElementById('lightbox');
      var img = document.getElementById('lightboxImg');
      img.src = src;
      box.style.display = 'flex';
    }

    function closeLightbox() {
      document.getElementById('lightbox').style.display = 'none';
    }

    function formatDisplayDate(raw) {
      if (!raw) return '';
      return String(raw).replace(/T/g, ' ').replace(/:\d{2}(?:\.\d+)?Z$/i, '').replace(/Z$/i, '').trim();
    }

    function escHtml(str) {
      return String(str || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function formatPostTextClient(text) {
      var escaped = escHtml(text);
      var withUrls = escaped.replace(/(https?:\\\/\\\/[^\\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="post-link">$1<\\\/a>');
      var withMentions = withUrls.replace(/(^|\\s)@([A-Za-z0-9._]+)/g, '$1<a href="/@$2" class="post-mention">@$2<\\\/a>');
      return withMentions.replace(/\\n/g, '<br>');
    }

    function toggleComments(a, b, c) {
      var username = c ? a : currentUsername;
      var idx = c ? b : a;
      var box = document.getElementById('comments-' + idx);
      if (!box) return;
      if (box.style.display === 'block') {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'block';

      if (box.dataset.loaded) return;

      loadCommentsForPost(username, idx, false);
    }

    function loadCommentsForPost(username, idx, refresh) {
      var box = document.getElementById('comments-' + idx);
      if (!box) return;
      box.innerHTML = '<div class="comments-loading"><span class="loading-bar"></span> ${t.loading_comments}</div>';

      fetch('/api/comments/' + encodeURIComponent(username) + '/' + idx + (refresh ? '?refresh=1' : ''))
        .then(function(res) { return res.json(); })
        .then(function(data) {
          box.dataset.loaded = 'true';
          if (!data.ok || !data.comments || !data.comments.length) {
            box.innerHTML = '<div class="comments-empty">${t.no_comments}</div>';
            return;
          }
          box._allComments = data.comments;
          box._shownCount = 10;
          renderCommentsList(box, idx, username);
        })
        .catch(function() {
          box.innerHTML = '<div class="comments-error">${t.toast_error}</div>';
        });
    }

    function renderCommentsList(box, idx, username) {
      var comments = box._allComments || [];
      var shown = Math.min(box._shownCount || 10, comments.length);
      var html = '<div class="comments-list">';
      for (var i = 0; i < shown; i++) {
        var c = comments[i];
        var a = (c.author || '@anonymous').trim();
        var handle = a.replace(/^@/, '');
        var avatarHtml = c.avatar
          ? '<img src="' + escHtml(c.avatar) + '" data-orig="' + escHtml(c.avatar) + '" class="comment-author-avatar" alt="' + escHtml(handle) + '" referrerpolicy="no-referrer" onerror="handleImgError(this)" />'
          : '<div class="comment-author-avatar" style="display:flex;align-items:center;justify-content:center;font-size:10px;color:#777;">@</div>';

        html += '<div class="comment-row">' +
          '<div class="comment-author-block">' +
            avatarHtml +
            '<a href="/@' + encodeURIComponent(handle) + (currentLang === 'en' ? '?lang=en' : '') + '" class="comment-author-name">' + escHtml(a) + '</a>' +
          '</div>' +
          '<div class="comment-content">' + formatPostTextClient(c.text || '') + '</div>' +
        '</div>';
      }
      html += '</div>';

      var moreBtns = '<div style="display:flex;gap:8px;justify-content:center;margin-top:10px;">';
      if (shown < comments.length) {
        var remaining = comments.length - shown;
        moreBtns += '<button class="btn-sharp" style="font-size:0.8rem;padding:4px 12px;" onclick="showMoreLocalComments(' + idx + ')">' + (currentLang === 'en' ? 'Show more (' + remaining + ')' : 'Показать ещё (' + remaining + ')') + '</button>';
      }
      moreBtns += '<button class="btn-sharp" style="font-size:0.8rem;padding:4px 12px;opacity:0.85;" onclick="loadCommentsForPost(currentUsername, ' + idx + ', true)">' + (currentLang === 'en' ? 'Refresh comments' : 'Обновить комментарии') + '</button>';
      moreBtns += '</div>';

      html += moreBtns;
      box.innerHTML = html;
    }

    function showMoreLocalComments(idx) {
      var box = document.getElementById('comments-' + idx);
      if (!box || !box._allComments) return;
      box._shownCount = (box._shownCount || 10) + 15;
      renderCommentsList(box, idx, currentUsername);
    }

    function toggleTheme() {
      var isLight = document.documentElement.getAttribute('data-theme') === 'light';
      if (isLight) {
        document.documentElement.removeAttribute('data-theme');
        localStorage.setItem('threads_theme', 'dark');
      } else {
        document.documentElement.setAttribute('data-theme', 'light');
        localStorage.setItem('threads_theme', 'light');
      }
      updateThemeBtnText();
    }
    function updateThemeBtnText() {
      var el = document.getElementById('themeToggleText');
      if (!el) return;
      var isLight = document.documentElement.getAttribute('data-theme') === 'light';
      var isEn = currentLang === 'en';
      if (isEn) {
        el.innerText = isLight ? 'Dark' : 'Light';
      } else {
        el.innerText = isLight ? 'Темная' : 'Светлая';
      }
    }
    var targetPostId = "${esc(targetPostId || "")}";
    function initProfilePage() {
      updateThemeBtnText();
      checkFavoriteStatus();
      if (targetPostId) {
        setTimeout(function() {
          var el = document.getElementById('post-' + targetPostId);
          if (el) {
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            var btn = el.querySelector('.comment-btn');
            if (btn) btn.click();
          }
        }, 350);
      }
    }
    document.addEventListener('DOMContentLoaded', initProfilePage);
    initProfilePage();

    function handleNavSearch(e) {
      e.preventDefault();
      var input = document.getElementById('navSearchInput');
      var clean = (input.value || '').trim();
      var postRegex = new RegExp('(?:threads\\\\.(?:com|net)/)?@?([A-Za-z0-9._]+)/post/([A-Za-z0-9._-]+)', 'i');
      var postMatch = clean.match(postRegex);
      if (postMatch) {
        window.location.href = '/@' + encodeURIComponent(postMatch[1]) + '/post/' + encodeURIComponent(postMatch[2]) + (currentLang === 'en' ? '?lang=en' : '');
        return;
      }
      var userRegex = new RegExp('(?:threads\\\\.(?:com|net)/)?@?([A-Za-z0-9._]+)', 'i');
      var userMatch = clean.match(userRegex);
      if (userMatch) {
        window.location.href = '/@' + encodeURIComponent(userMatch[1]) + (currentLang === 'en' ? '?lang=en' : '');
      }
    }

    function renderPostsClient(posts, profile) {
      var feed = document.getElementById('postsFeed');
      if (!feed) return;
      if (!posts || !posts.length) {
        feed.innerHTML = '<div class="status-card" style="text-align:center;padding:24px 16px;"><p style="color:#777;">' + (currentLang === 'en' ? 'No posts in this profile yet.' : 'В этом профиле пока нет постов.') + '</p></div>';
        return;
      }
      var html = '';
      for (var idx = 0; idx < posts.length; idx++) {
        var post = posts[idx];
        var postDate = formatDisplayDate(post.date || '');
        var authorName = post.author || (profile ? profile.displayName : '') || currentUsername;
        var authorAvatar = post.authorAvatar || (profile ? profile.avatar : '') || '';

        var videoHtml = post.videoUrl
          ? '<div class="post-media-box"><video src="/api/media?url=' + encodeURIComponent(post.videoUrl) + '" data-orig="' + escHtml(post.videoUrl) + '" controls playsinline preload="metadata" poster="' + escHtml(post.imageUrl || '') + '" onerror="handleVideoError(this)"></video></div>'
          : '';

        var mediaHtml = videoHtml || (post.imageUrl
          ? '<div class="post-media-box"><img src="' + escHtml(post.imageUrl) + '" data-orig="' + escHtml(post.imageUrl) + '" alt="Post image" referrerpolicy="no-referrer" onclick="openLightbox(this.src)" onerror="handleImgError(this)" /></div>'
          : '');

        var videoMarker = (post.has_video && !post.videoUrl)
          ? '<span class="video-indicator">${t.video}</span>'
          : '';

        var avatarHtml = authorAvatar
          ? '<img src="' + escHtml(authorAvatar) + '" data-orig="' + escHtml(authorAvatar) + '" class="post-author-avatar" alt="' + escHtml(authorName) + '" referrerpolicy="no-referrer" onerror="handleImgError(this)" />'
          : '<div class="post-author-avatar" style="display:flex;align-items:center;justify-content:center;color:#666;font-size:11px;">@</div>';

        html += '<article class="post-card" id="post-' + idx + '">' +
          '<div class="post-card-top">' +
            '<div class="post-author-block">' +
              avatarHtml +
              '<div>' +
                '<a href="/@' + escHtml(currentUsername) + (currentLang === 'en' ? '?lang=en' : '') + '" class="post-author-handle">' + escHtml(authorName) + '</a>' +
                (postDate ? '<div class="post-timestamp">' + escHtml(postDate) + '</div>' : '') +
              '</div>' +
            '</div>' +
            '<button class="toolbar-btn" title="${t.share_post}" onclick="copyPostLink(' + idx + ')">${t.share_post}</button>' +
          '</div>' +
          '<div class="post-body-text">' + formatPostTextClient(post.text || '') + '</div>' +
          videoMarker +
          mediaHtml +
          '<div class="post-toolbar">' +
            '<span class="post-metric" title="${t.like}">' +
              '<span class="post-metric-icon">&#9825;</span>' +
              '<span class="post-metric-label">${t.like}:</span>' +
              '<span class="post-metric-val">' + (post.likes ? escHtml(post.likes) : '0') + '</span>' +
            '</span>' +
            '<button class="toolbar-btn comment-btn" onclick="toggleComments(' + idx + ', this)" title="${t.comments}">' +
              '<span class="comment-label">${t.comments}</span>' +
              '<span class="comment-count">' + (post.replies ? ' (' + escHtml(post.replies) + ')' : '') + '</span>' +
            '</button>' +
            '<a href="https://t.me/${esc(tgUser)}?start=sub_' + escHtml(currentUsername) + '" target="_blank" rel="noopener" class="toolbar-btn" style="margin-left:auto;">${t.in_bot}</a>' +
          '</div>' +
          '<div class="comments-box" id="comments-' + idx + '"></div>' +
        '</article>';
      }
      feed.innerHTML = html;
    }

    if (!isLoaded) {
      var stepIdx = 0;
      var stepsRu = [
        'Запрашиваем профиль, посты и медиа с серверов Threads...',
        'Подключение к защищенному шлюзу и чтение постов...',
        'Загрузка медиафайлов и комментариев...',
        'Формирование ленты постов...'
      ];
      var stepsEn = [
        'Fetching profile, posts and media from Threads servers...',
        'Connecting to secure gateway and reading posts...',
        'Loading media and comments...',
        'Preparing post feed...'
      ];
      var stepInterval = setInterval(function() {
        stepIdx++;
        var list = currentLang === 'en' ? stepsEn : stepsRu;
        var txt = document.getElementById('loadingStatusText');
        if (txt && stepIdx < list.length) {
          txt.innerText = list[stepIdx];
        }
      }, 1800);

      fetch('/api/profile/' + encodeURIComponent(currentUsername))
        .then(function(res) { return res.json(); })
        .then(function(res) {
          clearInterval(stepInterval);
          if (res.ok && (res.posts || res.profile)) {
            var box = document.getElementById('loadingBox');
            if (box) box.style.display = 'none';

            if (res.profile) {
              if (res.profile.displayName) {
                var el = document.querySelector('.profile-name');
                if (el) el.innerText = res.profile.displayName;
              }
              if (res.profile.bio) {
                var bioEl = document.querySelector('.profile-bio');
                if (bioEl) {
                  bioEl.innerHTML = formatPostTextClient(res.profile.bio);
                } else {
                  var pCard = document.querySelector('.profile-card');
                  if (pCard) {
                    var newBio = document.createElement('div');
                    newBio.className = 'profile-bio';
                    newBio.innerHTML = formatPostTextClient(res.profile.bio);
                    var statsRow = document.querySelector('.profile-stats-row');
                    pCard.insertBefore(newBio, statsRow);
                  }
                }
              }
              if (res.profile.avatar) {
                var avBox = document.querySelector('.profile-avatar-box');
                if (avBox) {
                  avBox.innerHTML = '<img src="' + escHtml(res.profile.avatar) + '" data-orig="' + escHtml(res.profile.avatar) + '" class="profile-avatar-img" alt="' + escHtml(currentUsername) + '" referrerpolicy="no-referrer" onerror="handleImgError(this)" />';
                }
              }
              if (res.profile.followers) {
                var folRow = document.querySelector('.profile-stats-row');
                if (folRow && !folRow.innerText.includes(res.profile.followers)) {
                  var folSpan = document.createElement('span');
                  folSpan.innerText = '${t.followers_label}: ' + res.profile.followers;
                  folRow.insertBefore(folSpan, folRow.firstChild);
                }
              }
            }

            renderPostsClient(res.posts || [], res.profile);
            var moreSec = document.getElementById('loadMoreSection');
            if (moreSec && res.posts && res.posts.length) moreSec.style.display = 'block';
          } else {
            var box = document.getElementById('loadingBox');
            var title = document.getElementById('loadingStatusTitle');
            var txt = document.getElementById('loadingStatusText');
            var action = document.getElementById('loadingStatusAction');
            if (box) box.className = 'status-card status-card-error';
            if (title) {
              title.innerText = res.status === 'user_not_found'
                ? (currentLang === 'en' ? 'Profile Not Found in Threads' : 'Профиль не найден в Threads')
                : (currentLang === 'en' ? 'Unable to Load Posts' : 'Не удалось загрузить посты');
            }
            if (txt) {
              txt.innerText = res.error || (currentLang === 'en' ? 'User does not exist or has set their account to private.' : 'Пользователь не существует или закрыл аккаунт настройками приватности.');
            }
            if (action) action.style.display = 'block';
          }
        })
        .catch(function() {
          clearInterval(stepInterval);
          var box = document.getElementById('loadingBox');
          var title = document.getElementById('loadingStatusTitle');
          var txt = document.getElementById('loadingStatusText');
          var action = document.getElementById('loadingStatusAction');
          if (box) box.className = 'status-card status-card-error';
          if (title) title.innerText = currentLang === 'en' ? 'Connection Error' : 'Ошибка соединения';
          if (txt) txt.innerText = '${t.toast_error}';
          if (action) action.style.display = 'block';
        });
    }

    function loadMorePosts(username) {
      showToast('${t.toast_loading}');
      fetch('/api/profile/' + encodeURIComponent(username) + '?page=1')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok && data.posts && data.posts.length) {
            showToast('${t.toast_updated}');
          } else {
            showToast('${t.toast_all_loaded}');
          }
        })
        .catch(function() {
          showToast('${t.toast_error}');
        });
    }

    window.addEventListener('scroll', function() {
      if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 300) {
        var loadBtn = document.querySelector('#loadMoreSection button');
        if (loadBtn && !loadBtn.dataset.busy) {
          loadBtn.dataset.busy = '1';
          loadMorePosts(currentUsername);
        }
      }
    });
  </script>
  ${renderCookieBanner(lang)}
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": hasData ? "public, max-age=600" : "no-cache",
    },
  });
}

export function renderTermsPage(lang: Lang = "ru", origin = "https://threadsviewer.online"): Response {
  const isEn = lang === "en";
  const title = isEn ? "Terms of Service & Usage Limits" : "Пользовательское соглашение и лимиты сервиса";
  const date = isEn ? "Last updated: 2026-09-22" : "Дата обновления: 22 сентября 2026 г.";
  const backBtn = isEn ? "Back to Home" : "Вернуться на главную";
  const canonicalUrl = `${origin}/terms${isEn ? '?lang=en' : ''}`;

  const content = isEn ? `
    <h1>Terms of Service & Usage Limits</h1>
    <p class="terms-subtitle">${date}</p>

    <h2>1. General Provisions</h2>
    <p>Threads Viewer (threadsviewer.online, hereinafter referred to as the "Service") is an independent web viewer that provides convenient web access to publicly distributed content from the Threads social network without requiring VPN software or user account registration.</p>

    <h2>2. Disclaimer and Trademarks</h2>
    <p>The Service is not affiliated with, endorsed by, or sponsored by Meta Platforms Inc., Instagram, or Threads. All trademarks, brand logos, product names, and company emblems mentioned on this website belong to their respective copyright holders.</p>

    <h2>3. Website Usage Limits and Fair Use</h2>
    <p>- Reading public posts, profiles, photos, and comments directly on the website is completely free and unlimited for normal visitors.</p>
    <p>- To safeguard server capacity and maintain fast response times, an automated rate limit applies to automated scraper tools (maximum 20 new uncached profile lookups per 5 minutes per IP address).</p>
    <p>- Previously requested profiles are stored in Cloudflare Edge distributed cache and served with zero delay without consuming scraper resources.</p>

    <h2>4. Digital Goods, Premium Services & Tariffs</h2>
    <p>The Service offers digital access subscriptions with expanded capabilities:</p>
    <p>- Complete ad removal across the Threads Viewer website;</p>
    <p>- Real-time anonymous author tracking with instant delivery to Telegram;</p>
    <p>- Unrestricted browsing of deep comment threads and high-resolution media.</p>
    <p><b>Subscription Plans & Pricing:</b></p>
    <p>- Trial Plan (7 days access): $0.99 (or 99 Telegram Stars / 1.0 USDT); <a href="/pay?plan=7&currency=USD" style="display:inline-block;background:#2563eb;color:#fff;padding:2px 8px;text-decoration:none;font-weight:700;margin-left:6px;">Pay $0.99</a></p>
    <p>- Standard Plan (30 days access): $1.49 (or 149 Telegram Stars / 1.5 USDT). <a href="/pay?plan=30&currency=USD" style="display:inline-block;background:#2563eb;color:#fff;padding:2px 8px;text-decoration:none;font-weight:700;margin-left:6px;">Pay $1.49</a></p>
    <p>Payment methods: Bank cards (MIR, Visa, Mastercard), Faster Payments System (SBP), Telegram Stars, Cryptocurrency. All transactions are securely processed via certified payment gateways.</p>

    <h2>5. Order Fulfillment & Delivery Policy</h2>
    <p>All services provided by the Service are entirely digital. Service activation (digital delivery) occurs immediately and automatically upon confirmation of successful transaction by the payment provider. No physical shipment is required.</p>

    <h2>6. Refund Policy</h2>
    <p>- If the Service is unavailable due to technical failures on our side, or in case of erroneous duplicate billing, users are entitled to a full refund within 14 calendar days from the transaction date.</p>
    <p>- To request a refund, contact customer support via email at support@threadsviewer.online or via Telegram at @threadsreaderbot with your Order ID, payment date, and amount.</p>
    <p>- Refund requests are processed within 24 hours. Approved refunds are credited back to the original payment method within 1-5 business days depending on the issuing bank.</p>

    <h2>7. Disclaimer of Warranties</h2>
    <p>The Service is provided on an "as is" and "as available" basis without warranties of any kind. We do not guarantee uninterrupted uptime of upstream network resources and assume no liability for third-party public content retrieved from the Threads platform.</p>

    <h2>8. Support and Contacts</h2>
    <p>Customer Support: support@threadsviewer.online</p>
    <p>Telegram Support: @threadsreaderbot</p>
    <p>Support Hours: Daily, 09:00 - 22:00 MSK.</p>
  ` : `
    <h1>Пользовательское соглашение и лимиты сервиса</h1>
    <p class="terms-subtitle">${date}</p>

    <h2>1. Общие положения</h2>
    <p>Сервис Threads Viewer (threadsviewer.online, далее - "Сервис") представляет собой независимый веб-интерфейс для комфортного чтения и просмотра открытых публикаций, фотографий и комментариев из социальной сети Threads без необходимости использования VPN и без регистрации аккаунта.</p>

    <h2>2. Отказ от ответственности и товарные знаки</h2>
    <p>Сервис не является официальным продуктом и не аффилирован с корпорацией Meta Platforms Inc., Instagram или Threads. Все зарегистрированные товарные знаки, фирменные наименования и логотипы принадлежат их законным правообладателям.</p>

    <h2>3. Политика лимитов на сайте</h2>
    <p>- Просмотр профилей, постов, фотографий и комментариев на веб-сайте является бесплатным и безлимитным для обычных пользователей.</p>
    <p>- В целях защиты инфраструктуры от спам-атак и автоматических парсеров действует защитный фильтр частоты запросов (Rate Limit): не более 20 запросов к новым (ранее не сохраненным в кеше) профилям за 5 минут с одного IP-адреса.</p>
    <p>- Ранее открытые профили сохраняются в распределенном кеше Cloudflare Edge и отдаются мгновенно без каких-либо ограничений.</p>

    <h2>4. Описание цифровых услуг и тарифы</h2>
    <p>Сервис предоставляет цифровую платную подписку с расширенными возможностями:</p>
    <p>- Полное отключение рекламы на веб-сайте Threads Viewer;</p>
    <p>- Анонимный мониторинг авторов Threads в реальном времени с доставкой постов в Telegram;</p>
    <p>- Просмотр всех веток комментариев и медиафайлов без ограничений.</p>
    <p><b>Тарифные планы и стоимость:</b></p>
    <p>- Тариф "Пробный" (7 дней доступа): 99 руб. (или 39 Telegram Stars / 0.8 USDT); <a href="/pay?plan=7" style="display:inline-block;background:#2563eb;color:#fff;padding:2px 8px;text-decoration:none;font-weight:700;margin-left:6px;">Оплатить 99 ₽ (СБП/Карта)</a></p>
    <p>- Тариф "Стандартный" (30 дней доступа): 129 руб. (или 99 Telegram Stars / 1.8 USDT). <a href="/pay?plan=30" style="display:inline-block;background:#2563eb;color:#fff;padding:2px 8px;text-decoration:none;font-weight:700;margin-left:6px;">Оплатить 129 ₽ (СБП/Карта)</a></p>
    <p>Способы оплаты: Банковские карты (МИР, Visa, Mastercard), СБП (Система быстрых платежей), Telegram Stars, криптовалюта. Все расчеты производятся через защищенные шлюзы сертифицированных платёжных операторов.</p>

    <h2>5. Порядок оформления и доставки цифровых услуг</h2>
    <p>Оказываемые услуги носят исключительно цифровой характер. Предоставление доступа (доставка услуги) происходит мгновенно в автоматическом режиме сразу после подтверждения успешной оплаты банком или платёжным шлюзом. Никакой физической доставки не требуется.</p>

    <h2>6. Условия и порядок возврата денежных средств (Refund Policy)</h2>
    <p>- В случае технических сбоев на стороне Сервиса, препятствующих его использованию, либо при ошибочном списании средств, Пользователь имеет право на полный возврат в течение 14 календарных дней с момента оплаты.</p>
    <p>- Для оформления возврата Пользователь направляет обращение в службу поддержки по электронной почте support@threadsviewer.online или в Telegram: @threadsreaderbot с указанием номера заказа (Order ID), даты и суммы оплаты.</p>
    <p>- Срок рассмотрения заявления - не более 24 часов. Возврат средств производится на тот же платёжный инструмент (банковскую карту, кошелек), с которого была совершена оплата, в срок от 1 до 5 рабочих дней (в зависимости от банка-эмитента карты).</p>

    <h2>7. Отказ от гарантий</h2>
    <p>Сервис предоставляется по принципу "как есть" (as is). Администрация не гарантирует непрерывную доступность внешних серверов и не несет ответственности за материалы третьих лиц, опубликованные в открытом доступе на платформе Threads.</p>

    <h2>8. Контакты и служба поддержки</h2>
    <p>Электронная почта поддержки: support@threadsviewer.online</p>
    <p>Telegram-поддержка: @threadsreaderbot</p>
    <p>Режим работы поддержки: ежедневно, с 09:00 до 22:00 МСК.</p>
  `;

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <meta name="verification" content="7d97667a3e056acab9aaf653807b4a03">
  <link rel="canonical" href="${canonicalUrl}">
  <link rel="alternate" hreflang="ru" href="${origin}/terms?lang=ru">
  <link rel="alternate" hreflang="en" href="${origin}/terms?lang=en">
  <link rel="alternate" hreflang="x-default" href="${origin}/terms">
  <title>${title} - Threads Viewer</title>
  <script>
    (function(){
      var t = localStorage.getItem('threads_theme');
      if (t === 'light' || (!t && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)) {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    })();
  </script>
  <style>${COMMON_STYLES} .terms-card { background: #131313; border: 1px solid #2d2d2d; border-radius: 0; padding: 24px; margin: 30px auto; max-width: 680px; } .terms-card h1 { margin-bottom: 8px; font-size: 1.35rem; color: #fff; } .terms-card h2 { margin: 18px 0 6px; font-size: 1.02rem; color: #eee; } .terms-card p { color: #888888; margin-bottom: 8px; font-size: 0.88rem; line-height: 1.55; }</style>
</head>
<body>
  <div class="terms-card">
    ${content}
    <div style="margin-top: 22px;">
      <a href="/?lang=${lang}" class="btn-sharp">${backBtn}</a>
    </div>
  </div>
  ${renderCookieBanner(lang)}
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=UTF-8" } });
}

export function renderPrivacyPage(lang: Lang = "ru", origin = "https://threadsviewer.online"): Response {
  const isEn = lang === "en";
  const title = isEn ? "Privacy Policy" : "Политика конфиденциальности и обработки данных";
  const date = isEn ? "Last updated: 2026-09-22" : "Дата обновления: 22 сентября 2026 г.";
  const backBtn = isEn ? "Back to Home" : "Вернуться на главную";
  const canonicalUrl = `${origin}/privacy${isEn ? '?lang=en' : ''}`;

  const content = isEn ? `
    <h1>Privacy Policy</h1>
    <p class="terms-subtitle">${date}</p>

    <h2>1. General Provisions and Legal Basis</h2>
    <p>This Privacy Policy outlines how Threads Viewer (threadsviewer.online, hereinafter referred to as the "Service") handles technical information and ensures privacy standards in compliance with international data protection regulations and applicable laws.</p>
    <p>The Service is an independent, unofficial web viewer created exclusively for informational and reading purposes, providing web access to publicly distributed content from the Threads network.</p>

    <h2>2. Data Minimization and Collected Information</h2>
    <p>The Service adheres to the principle of data minimization:</p>
    <p>- We do not require account registration, usernames, passwords, phone numbers, or email addresses.</p>
    <p>- We do not collect, process, or store personally identifiable information (PII) such as full names, identity documents, or financial payment details.</p>
    <p>- We do not operate user profile databases or link online actions to physical individuals.</p>

    <h2>3. Technical Logs and Automated Processing</h2>
    <p>To ensure infrastructure security, prevent automated spam attacks (DDoS), and optimize content delivery, our edge servers (Cloudflare) automatically record non-identifying technical request parameters:</p>
    <p>- IP address of the incoming HTTP request (used solely for rate limiting and threat mitigation);</p>
    <p>- User-Agent header, operating system type, and browser version;</p>
    <p>- Requested URL path and timestamp of access.</p>
    <p>Technical log entries are automatically purged on a scheduled rolling basis.</p>

    <h2>4. Cookies and Local Storage</h2>
    <p>The Service uses strictly necessary technical cookies and client-side LocalStorage:</p>
    <p>- Interface theme preference (light or dark mode, stored in LocalStorage);</p>
    <p>- Language preference (ru or en, stored in LocalStorage and a technical cookie);</p>
    <p>- Cookie notice acknowledgment (stored in LocalStorage to avoid repeated prompts);</p>
    <p>- Optional authentication token (threads_auth) for verified Telegram bot subscribers requesting an ad-free view.</p>
    <p>The Service does not deploy third-party cross-site advertising trackers or social surveillance scripts.</p>

    <h2>5. Public Information</h2>
    <p>All profile metadata, text posts, media items, and comments displayed via the Service represent publicly accessible information shared openly by authors on the Threads platform. The Service does not bypass privacy walls, password-protected feeds, or private accounts.</p>

    <h2>6. Information Security</h2>
    <p>All data transit between the user device and the Service is encrypted using modern TLS and HTTPS protocols. Edge caching nodes store publicly available responses temporarily to minimize upstream server load.</p>

    <h2>7. Inquiries and Contact</h2>
    <p>For questions regarding this policy, data processing inquiries, or content issues, please contact our support desk via email at support@threadsviewer.online or via the official Telegram bot: @threadsreaderbot.</p>
  ` : `
    <h1>Политика конфиденциальности и обработки данных</h1>
    <p class="terms-subtitle">${date}</p>

    <h2>1. Общие положения и правовые основания</h2>
    <p>Настоящая Политика обработки данных (далее - "Политика") определяет порядок обработки технической информации и меры по обеспечению безопасности в сервисе Threads Viewer (threadsviewer.online, далее - "Сервис") в соответствии с требованиями Федерального закона от 27.07.2006 № 152-ФЗ "О персональных данных" и общепринятыми международными стандартами конфиденциальности.</p>
    <p>Сервис является независимым неофициальным веб-интерфейсом, созданным для чтения и просмотра открытой информации, опубликованной в публичном доступе пользователями социальной сети Threads.</p>

    <h2>2. Принцип минимизации и категории данных</h2>
    <p>Сервис строго придерживается принципа минимизации данных:</p>
    <p>- Сервис не требует регистрации, создания учетной записи, ввода паролей, номеров телефонов или адресов электронной почты.</p>
    <p>- Сервис не собирает, не обрабатывает и не хранит персональные данные физических лиц, позволяющие идентифицировать конкретного пользователя (ФИО, паспортные данные, контакты, платежные реквизиты).</p>
    <p>- Сервис не осуществляет сопоставление сетевых запросов с личностями реальных пользователей.</p>

    <h2>3. Технические журналы и автоматическая обработка</h2>
    <p>В целях обеспечения устойчивой работы, защиты от вредоносных автоматизированных запросов (DDoS-атак) и кеширования контента серверы инфраструктуры (Cloudflare) в автоматическом режиме могут фиксировать технические обезличенные параметры:</p>
    <p>- Сетевой IP-адрес входящего запроса (используется исключительно для ограничения частоты запросов и фильтрации ботов);</p>
    <p>- Идентификатор браузера (User-Agent) и тип операционной системы;</p>
    <p>- Запрашиваемый URL-адрес и метку времени обращения.</p>
    <p>Технические логи хранятся временно и регулярно удаляются в автоматическом режиме.</p>

    <h2>4. Файлы Cookie и локальное хранилище</h2>
    <p>Сервис использует исключительно технические файлы cookie и данные локального хранилища браузера (LocalStorage):</p>
    <p>- Сохранение цветовой темы интерфейса (светлая или темная, в LocalStorage);</p>
    <p>- Сохранение языковой версии (ru или en, в cookie и LocalStorage);</p>
    <p>- Фиксация согласия с уведомлением об использовании файлов cookie (в LocalStorage);</p>
    <p>- Сессионный токен авторизации (threads_auth) для подписчиков Telegram-бота, использующих режим без рекламы.</p>
    <p>Сервис не применяет сторонние межсайтовые трекеры, пиксели рекламных сетей или аналитические системы с передачей персональных данных.</p>

    <h2>5. Общедоступный характер информации</h2>
    <p>Все отображаемые текстовые посты, фотографии, видеоматериалы и комментарии являются общедоступной информацией в соответствии со статьей 7 Федерального закона от 27.07.2006 № 149-ФЗ "Об информации, информационных технологиях и о защите информации", открыто размещенной авторами на платформе Threads. Сервис не получает и не отображает информацию из закрытых (приватных) профилей.</p>

    <h2>6. Безопасность передачи данных</h2>
    <p>Вся передача данных между устройством пользователя и Сервисом защищена современными протоколами шифрования HTTPS и TLS. Обработка запросов осуществляется с применением распределенной инфраструктуры Cloudflare Edge.</p>

    <h2>7. Контакты и обратная связь</h2>
    <p>По любым вопросам, связанным с настоящей Политикой, а также по вопросам функционирования сервиса, вы можете обратиться в службу поддержки по электронной почте support@threadsviewer.online или через официальный Telegram-бот: @threadsreaderbot.</p>
  `;

  const html = `<!DOCTYPE html>
<html lang="${lang}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <meta name="verification" content="7d97667a3e056acab9aaf653807b4a03">
  <link rel="canonical" href="${canonicalUrl}">
  <link rel="alternate" hreflang="ru" href="${origin}/privacy?lang=ru">
  <link rel="alternate" hreflang="en" href="${origin}/privacy?lang=en">
  <link rel="alternate" hreflang="x-default" href="${origin}/privacy">
  <title>${title} - Threads Viewer</title>
  <script>
    (function(){
      var t = localStorage.getItem('threads_theme');
      if (t === 'light' || (!t && window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches)) {
        document.documentElement.setAttribute('data-theme', 'light');
      }
    })();
  </script>
  <style>${COMMON_STYLES} .terms-card { background: #131313; border: 1px solid #2d2d2d; border-radius: 0; padding: 24px; margin: 30px auto; max-width: 680px; } .terms-card h1 { margin-bottom: 8px; font-size: 1.35rem; color: #fff; } .terms-card h2 { margin: 18px 0 6px; font-size: 1.02rem; color: #eee; } .terms-card p { color: #888888; margin-bottom: 8px; font-size: 0.88rem; line-height: 1.55; }</style>
</head>
<body>
  <div class="terms-card">
    ${content}
    <div style="margin-top: 22px;">
      <a href="/?lang=${lang}" class="btn-sharp">${backBtn}</a>
    </div>
  </div>
  ${renderCookieBanner(lang)}
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=UTF-8" } });
}

export function renderRobotsTxt(origin: string): Response {
  const txt = `User-agent: *
Allow: /
Allow: /@*
Allow: /profile/*
Allow: /terms
Allow: /privacy
Disallow: /api/
Disallow: /telegram/

Sitemap: ${origin}/sitemap.xml
`;
  return new Response(txt, { headers: { "content-type": "text/plain; charset=UTF-8" } });
}

export function renderSitemap(origin: string, popularProfiles: string[]): Response {
  const urls = [
    `${origin}/`,
    `${origin}/ru/`,
    `${origin}/en/`,
    `${origin}/terms`,
    `${origin}/privacy`,
    ...popularProfiles.map(u => `${origin}/@${u}`),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${esc(u)}</loc>
    <changefreq>${u.includes('/@') ? 'hourly' : 'daily'}</changefreq>
    <priority>${u.endsWith('/') ? '1.0' : (u.includes('/@') ? '0.8' : '0.5')}</priority>
  </url>`).join("\n")}
</urlset>`;

  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=UTF-8",
      "cache-control": "public, max-age=3600, s-maxage=3600",
    },
  });
}

export async function handleMediaProxy(request: Request): Promise<Response> {
  const urlParam = new URL(request.url).searchParams.get("url");
  if (!urlParam) {
    return new Response("Missing url param", { status: 400 });
  }

  let parsed: URL;
  try {
    parsed = new URL(urlParam);
  } catch {
    return new Response("Invalid url", { status: 400 });
  }

  const host = parsed.hostname.toLowerCase();
  const isAllowed = host.endsWith(".cdninstagram.com") || host.endsWith(".fbcdn.net") || host.endsWith(".threads.net");
  if (!isAllowed) {
    return new Response("Forbidden host", { status: 403 });
  }

  try {
    const upstreamHeaders: Record<string, string> = {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": "https://www.threads.com/",
      "Accept": "*/*",
    };
    const range = request.headers.get("range");
    if (range) {
      upstreamHeaders["Range"] = range;
    }

    const upstream = await fetch(urlParam, {
      headers: upstreamHeaders,
    });

    if (!upstream.ok && upstream.status !== 206) {
      return new Response("Upstream media error", { status: upstream.status });
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const resHeaders = new Headers();
    resHeaders.set("content-type", contentType);
    resHeaders.set("cache-control", "public, max-age=604800, stale-while-revalidate=2592000");
    if (upstream.headers.has("content-range")) {
      resHeaders.set("content-range", upstream.headers.get("content-range")!);
    }
    if (upstream.headers.has("accept-ranges")) {
      resHeaders.set("accept-ranges", upstream.headers.get("accept-ranges")!);
    }
    if (upstream.headers.has("content-length")) {
      resHeaders.set("content-length", upstream.headers.get("content-length")!);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: resHeaders,
    });
  } catch {
    return new Response("Failed to fetch media", { status: 502 });
  }
}

export const handleImageProxy = handleMediaProxy;
