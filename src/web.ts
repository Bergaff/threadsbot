import type { Env } from "./config";
import type { Comment, Post, ProfileData, ProfileMeta } from "./threads";

function esc(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function sanitizeUrl(url: string): string {
  const trimmed = (url || "").trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (trimmed.startsWith("/")) return trimmed;
  return "#";
}

function formatPostText(text: string): string {
  const escaped = esc(text);
  // Auto-link URLs
  const withUrls = escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="post-link">$1</a>');
  // Auto-link @mentions
  const withMentions = withUrls.replace(/(^|\s)@([A-Za-z0-9._]+)/g, '$1<a href="/@$2" class="post-mention">@$2</a>');
  // Auto-link #hashtags
  const withTags = withMentions.replace(/(^|\s)#([\w\u0400-\u04FF]+)/g, '$1<span class="post-hashtag">#$2</span>');
  return withTags.replace(/\n/g, "<br>");
}

function getBotUsername(env: Env): string {
  return "threads_reader_bot";
}

const COMMON_STYLES = `
  :root {
    --bg-page: #101010;
    --bg-card: #181818;
    --bg-card-hover: #1f1f1f;
    --bg-input: #242424;
    --border: #2c2c2c;
    --border-subtle: #222222;
    --text-primary: #f3f5f7;
    --text-secondary: #888888;
    --text-muted: #555555;
    --accent-blue: #0095f6;
    --accent-tg: #24A1DE;
    --accent-like: #ff3040;
    --badge-bg: #222222;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    background-color: var(--bg-page);
    color: var(--text-primary);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    -webkit-font-smoothing: antialiased;
    line-height: 1.45;
    padding-bottom: 80px;
  }
  a { color: inherit; text-decoration: none; }

  /* Header */
  .navbar {
    position: sticky;
    top: 0;
    z-index: 100;
    background: rgba(16, 16, 16, 0.85);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border-bottom: 1px solid var(--border);
    height: 60px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    max-width: 900px;
    margin: 0 auto;
  }
  .navbar-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    font-weight: 700;
    font-size: 1.15rem;
    letter-spacing: -0.02em;
    color: #fff;
  }
  .navbar-logo {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    background: #000;
    border: 1px solid var(--border);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 900;
    font-size: 18px;
    color: #fff;
  }
  .navbar-search {
    flex: 1;
    max-width: 360px;
    margin: 0 14px;
    position: relative;
  }
  .navbar-search input {
    width: 100%;
    background: var(--bg-input);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 8px 14px 8px 36px;
    color: #fff;
    font-size: 0.9rem;
    outline: none;
    transition: border-color 0.2s, background 0.2s;
  }
  .navbar-search input:focus {
    border-color: #555;
    background: #2a2a2a;
  }
  .navbar-search-icon {
    position: absolute;
    left: 12px;
    top: 50%;
    transform: translateY(-50%);
    color: var(--text-secondary);
    pointer-events: none;
    display: flex;
  }
  .navbar-actions {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .tg-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: var(--accent-tg);
    color: #fff;
    padding: 7px 14px;
    border-radius: 20px;
    font-size: 0.85rem;
    font-weight: 600;
    transition: opacity 0.2s, transform 0.1s;
  }
  .tg-btn:hover { opacity: 0.92; }
  .tg-btn:active { transform: scale(0.98); }

  /* Promo & Announcement Bar */
  .promo-bar {
    background: linear-gradient(90deg, #182848 0%, #2980b9 100%);
    color: #ffffff;
    font-size: 0.85rem;
    font-weight: 500;
    text-align: center;
    padding: 10px 16px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    flex-wrap: wrap;
    box-shadow: 0 2px 10px rgba(0,0,0,0.3);
  }
  .promo-bar a {
    background: #ffffff;
    color: #182848;
    padding: 4px 12px;
    border-radius: 14px;
    font-weight: 700;
    font-size: 0.78rem;
    text-transform: uppercase;
    letter-spacing: 0.03em;
  }

  /* Main Container */
  .container {
    max-width: 620px;
    margin: 24px auto;
    padding: 0 16px;
  }

  /* Search & Hero on Home */
  .hero {
    text-align: center;
    padding: 40px 12px 24px;
  }
  .hero-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #1e1e1e;
    border: 1px solid var(--border);
    color: #4ade80;
    padding: 5px 12px;
    border-radius: 20px;
    font-size: 0.8rem;
    font-weight: 600;
    margin-bottom: 16px;
  }
  .hero-title {
    font-size: 2.2rem;
    font-weight: 800;
    letter-spacing: -0.03em;
    margin-bottom: 12px;
    line-height: 1.2;
    background: linear-gradient(180deg, #ffffff 0%, #aaaaaa 100%);
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
  }
  .hero-subtitle {
    color: var(--text-secondary);
    font-size: 1.05rem;
    max-width: 480px;
    margin: 0 auto 28px;
  }
  .hero-search-box {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 28px;
    padding: 6px 8px 6px 18px;
    display: flex;
    align-items: center;
    gap: 10px;
    box-shadow: 0 8px 24px rgba(0,0,0,0.4);
    max-width: 520px;
    margin: 0 auto 20px;
  }
  .hero-search-box input {
    flex: 1;
    background: transparent;
    border: none;
    color: #fff;
    font-size: 1rem;
    outline: none;
  }
  .hero-search-box button {
    background: #ffffff;
    color: #000;
    border: none;
    border-radius: 20px;
    padding: 10px 20px;
    font-weight: 700;
    font-size: 0.9rem;
    cursor: pointer;
    transition: opacity 0.2s;
  }
  .hero-search-box button:hover { opacity: 0.88; }
  .popular-chips {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
    margin-top: 14px;
  }
  .popular-chip {
    background: #1c1c1c;
    border: 1px solid var(--border);
    padding: 6px 14px;
    border-radius: 18px;
    font-size: 0.82rem;
    color: var(--text-secondary);
    transition: all 0.2s;
  }
  .popular-chip:hover {
    color: #fff;
    border-color: #555;
    background: #252525;
  }

  /* Features Grid */
  .features-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 16px;
    margin: 36px 0;
  }
  .feature-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 20px;
  }
  .feature-icon {
    font-size: 28px;
    margin-bottom: 12px;
  }
  .feature-title {
    font-size: 1.05rem;
    font-weight: 700;
    margin-bottom: 6px;
    color: #fff;
  }
  .feature-desc {
    font-size: 0.88rem;
    color: var(--text-secondary);
    line-height: 1.45;
  }

  /* Profile Header */
  .profile-header-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 24px;
    margin-bottom: 20px;
    position: relative;
  }
  .profile-top {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
  }
  .profile-names {
    flex: 1;
  }
  .profile-display-name {
    font-size: 1.5rem;
    font-weight: 800;
    color: #fff;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .verified-badge {
    color: var(--accent-blue);
    display: inline-flex;
  }
  .profile-username {
    font-size: 0.95rem;
    color: var(--text-secondary);
    margin-top: 2px;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .threads-tag {
    background: var(--badge-bg);
    border: 1px solid var(--border);
    font-size: 0.72rem;
    padding: 2px 7px;
    border-radius: 10px;
    color: var(--text-secondary);
  }
  .profile-avatar-wrap {
    width: 76px;
    height: 76px;
    border-radius: 50%;
    overflow: hidden;
    background: #252525;
    flex-shrink: 0;
    border: 2px solid var(--border);
  }
  .profile-avatar {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .profile-bio {
    margin-top: 14px;
    font-size: 0.95rem;
    color: var(--text-primary);
    white-space: pre-line;
    line-height: 1.4;
  }
  .profile-meta-row {
    margin-top: 16px;
    display: flex;
    align-items: center;
    gap: 16px;
    font-size: 0.85rem;
    color: var(--text-secondary);
    flex-wrap: wrap;
  }
  .profile-actions {
    margin-top: 18px;
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
  }
  .btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 9px 18px;
    border-radius: 12px;
    font-size: 0.9rem;
    font-weight: 600;
    cursor: pointer;
    border: none;
    transition: all 0.15s;
  }
  .btn-primary {
    background: #fff;
    color: #000;
  }
  .btn-primary:hover { opacity: 0.9; }
  .btn-tg {
    background: var(--accent-tg);
    color: #fff;
  }
  .btn-tg:hover { opacity: 0.92; }
  .btn-secondary {
    background: #252525;
    color: #fff;
    border: 1px solid var(--border);
  }
  .btn-secondary:hover { background: #2f2f2f; }

  /* Feed and Post Cards */
  .feed {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .post-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 18px;
    padding: 18px;
    transition: border-color 0.2s, background 0.2s;
  }
  .post-card:hover {
    border-color: #383838;
  }
  .post-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 12px;
  }
  .post-author {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .post-avatar {
    width: 38px;
    height: 38px;
    border-radius: 50%;
    background: #262626;
    object-fit: cover;
  }
  .post-author-name {
    font-weight: 700;
    font-size: 0.92rem;
    color: #fff;
    display: flex;
    align-items: center;
    gap: 4px;
  }
  .post-author-name:hover { text-decoration: underline; }
  .post-date {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }
  .post-body {
    font-size: 0.96rem;
    color: var(--text-primary);
    line-height: 1.5;
    word-break: break-word;
    margin-bottom: 12px;
  }
  .post-link { color: var(--accent-blue); }
  .post-mention { color: #fff; font-weight: 600; }
  .post-mention:hover { text-decoration: underline; }
  .post-hashtag { color: var(--accent-blue); }

  /* Media */
  .post-media {
    border-radius: 14px;
    overflow: hidden;
    margin-bottom: 12px;
    border: 1px solid var(--border-subtle);
    background: #0d0d0d;
    max-height: 520px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .post-media img {
    width: 100%;
    max-height: 520px;
    object-fit: cover;
    display: block;
    cursor: zoom-in;
    transition: transform 0.2s;
  }
  .post-media img:hover { transform: scale(1.01); }
  .post-video-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: rgba(0,0,0,0.7);
    border: 1px solid var(--border);
    padding: 4px 10px;
    border-radius: 12px;
    font-size: 0.78rem;
    color: #fff;
    margin-bottom: 8px;
  }

  /* Post Actions */
  .post-actions {
    display: flex;
    align-items: center;
    gap: 18px;
    padding-top: 10px;
    border-top: 1px solid var(--border-subtle);
    color: var(--text-secondary);
    font-size: 0.88rem;
  }
  .post-action-btn {
    background: none;
    border: none;
    color: inherit;
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.86rem;
    cursor: pointer;
    transition: color 0.15s;
    padding: 4px 6px;
    border-radius: 8px;
  }
  .post-action-btn:hover { color: #fff; background: #222; }
  .post-action-btn.liked { color: var(--accent-like); }

  /* Comments Container */
  .comments-container {
    margin-top: 14px;
    padding-top: 12px;
    border-top: 1px dashed var(--border);
    display: none;
  }
  .comment-item {
    padding: 8px 0;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 0.88rem;
  }
  .comment-item:last-child { border-bottom: none; }
  .comment-author {
    font-weight: 700;
    color: #fff;
    margin-bottom: 2px;
  }
  .comment-text {
    color: var(--text-primary);
  }

  /* Ads & Monetization Box */
  .ad-box {
    background: linear-gradient(135deg, #161a22 0%, #1e222d 100%);
    border: 1px dashed #3a4150;
    border-radius: 16px;
    padding: 18px 22px;
    margin: 18px 0;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .ad-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #7d8590;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .ad-content {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .ad-text h4 {
    font-size: 1rem;
    color: #fff;
    margin-bottom: 4px;
  }
  .ad-text p {
    font-size: 0.85rem;
    color: #adbac7;
  }
  .ad-button {
    background: #238636;
    color: #fff;
    padding: 8px 16px;
    border-radius: 10px;
    font-weight: 700;
    font-size: 0.85rem;
    white-space: nowrap;
    transition: opacity 0.2s;
  }
  .ad-button:hover { opacity: 0.9; }

  /* Infinite Scroll / Loading */
  .loading-spinner {
    text-align: center;
    padding: 30px;
    color: var(--text-secondary);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 12px;
  }
  .spinner {
    width: 32px;
    height: 32px;
    border: 3px solid var(--border);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  .empty-state {
    text-align: center;
    padding: 40px 20px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 20px;
    color: var(--text-secondary);
  }
  .empty-state h3 { color: #fff; margin-bottom: 8px; }

  /* Toast Notification */
  .toast {
    position: fixed;
    bottom: 24px;
    left: 50%;
    transform: translateX(-50%) translateY(100px);
    background: #fff;
    color: #000;
    font-weight: 600;
    padding: 10px 20px;
    border-radius: 24px;
    font-size: 0.9rem;
    box-shadow: 0 8px 24px rgba(0,0,0,0.6);
    z-index: 1000;
    opacity: 0;
    transition: all 0.3s cubic-bezier(0.16, 1, 0.3, 1);
    pointer-events: none;
  }
  .toast.show {
    transform: translateX(-50%) translateY(0);
    opacity: 1;
  }

  /* Lightbox */
  .lightbox {
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.92);
    display: none;
    align-items: center;
    justify-content: center;
    z-index: 2000;
    padding: 20px;
  }
  .lightbox img {
    max-width: 95%;
    max-height: 90vh;
    border-radius: 12px;
    box-shadow: 0 10px 40px rgba(0,0,0,0.8);
  }
  .lightbox-close {
    position: absolute;
    top: 20px;
    right: 24px;
    color: #fff;
    font-size: 32px;
    cursor: pointer;
    background: none;
    border: none;
  }

  /* Footer */
  .footer {
    max-width: 620px;
    margin: 40px auto 0;
    padding: 20px 16px;
    border-top: 1px solid var(--border);
    text-align: center;
    font-size: 0.82rem;
    color: var(--text-secondary);
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .footer-links {
    display: flex;
    justify-content: center;
    gap: 16px;
  }
  .footer-links a:hover { color: #fff; }

  @media (max-width: 600px) {
    .navbar-search { display: none; }
    .hero-title { font-size: 1.7rem; }
    .profile-top { flex-direction: column-reverse; }
    .profile-avatar-wrap { width: 68px; height: 68px; }
  }
`;

const SVG_ICONS = {
  threads: `<svg width="20" height="20" viewBox="0 0 192 192" fill="currentColor"><path d="M141.537 88.9883C140.71 88.5919 139.87 88.2109 139.019 87.8451C137.537 60.5382 122.616 44.905 97.5619 44.745C97.4484 44.7443 97.3355 44.7443 97.222 44.745C77.8185 44.745 61.7661 55.4526 55.074 72.8805L70.4367 79.4389C74.6788 68.3846 84.7735 61.5977 97.1627 61.5977C97.2452 61.5977 97.3276 61.5977 97.4101 61.5984C111.905 61.6917 121.282 71.7453 122.569 88.8983C116.326 89.3787 109.914 90.3129 103.447 91.6881C80.3704 96.6022 65.5786 109.324 66.8659 127.323C67.8768 141.455 79.2559 152.029 93.9995 152.029C94.4925 152.029 94.9856 152.008 95.4786 151.966C112.599 150.518 123.633 139.117 128.537 127.27C133.09 134.187 139.467 139.387 147.28 142.164C151.983 143.834 157.067 144.595 162.296 144.385C164.717 144.288 166.726 142.341 166.75 139.919L166.812 133.673C166.837 131.295 164.939 129.336 162.564 129.288C152.327 129.081 144.208 123.475 142.877 113.888C148.914 104.285 152.062 92.5188 152.124 79.8886C152.197 45.4192 129.614 24.3168 97.3587 24.3168C61.3283 24.3168 33.5654 49.3233 33.5654 90.627C33.5654 133.407 62.7725 159.278 97.0906 159.278C113.823 159.278 128.608 153.228 139.697 142.274L128.093 131.603C119.531 140.063 108.618 144.609 97.0906 144.609C72.0729 144.609 49.206 124.966 49.206 90.627C49.206 58.7424 70.3642 38.9859 97.3587 38.9859C121.242 38.9859 136.577 53.6406 136.515 79.9197C136.463 90.3541 133.649 100.086 128.372 108.109C124.498 100.758 118.069 95.8443 106.666 94.0205C99.8519 92.9304 93.3005 92.3557 87.0519 92.3043C78.3619 92.2327 70.4367 94.2709 63.858 98.2435C56.6859 102.574 52.4172 109.431 51.9961 117.373C51.3789 129.026 60.5966 137.915 73.1947 137.915C84.7212 137.915 94.9485 130.439 99.4129 118.721C101.402 113.498 102.433 107.601 102.66 101.372C108.207 100.281 113.784 99.5516 119.341 99.1818C120.301 106.903 123.633 113.888 128.537 119.532C126.744 123.957 123.774 128.001 119.649 131.502C113.568 136.657 105.158 139.739 94.5027 140.643C85.5005 141.411 77.8391 135.539 77.1691 126.146C76.5412 117.353 84.1878 109.117 99.8315 105.787C105.348 104.614 110.875 103.853 116.382 103.493C116.897 108.825 118.176 114.341 120.248 119.81L128.537 127.27C128.537 127.27 128.537 127.27 128.537 127.27Z"/></svg>`,
  telegram: `<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm4.64 6.8c-.15 1.58-.8 5.42-1.13 7.19-.14.75-.42 1-.68 1.03-.58.05-1.02-.38-1.58-.75-.88-.58-1.38-.94-2.23-1.5-.99-.65-.35-1.01.22-1.59.15-.15 2.71-2.48 2.76-2.69a.2.2 0 00-.05-.18c-.06-.05-.14-.03-.21-.02-.09.02-1.49.95-4.22 2.79-.4.27-.76.41-1.08.4-.36-.01-1.04-.2-1.55-.37-.63-.2-1.12-.31-1.08-.66.02-.18.27-.36.74-.55 2.92-1.27 4.86-2.11 5.83-2.51 2.78-1.16 3.35-1.36 3.73-1.36.08 0 .27.02.39.12.1.08.13.19.14.27-.01.06.01.24 0 .38z"/></svg>`,
  search: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"></circle><line x1="21" y1="21" x2="16.65" y2="16.65"></line></svg>`,
  verified: `<svg class="verified-badge" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/></svg>`,
  heart: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>`,
  comment: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"></path></svg>`,
  share: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path><polyline points="16 6 12 2 8 6"></polyline><line x1="12" y1="2" x2="12" y2="15"></line></svg>`,
};

function renderNavbar(env: Env, searchDefault = ""): string {
  const tgUser = getBotUsername(env);
  return `
    <header class="navbar">
      <a href="/" class="navbar-brand">
        <div class="navbar-logo">@</div>
        <span>Threads Viewer</span>
      </a>
      <div class="navbar-search">
        <span class="navbar-search-icon">${SVG_ICONS.search}</span>
        <form onsubmit="handleNavSearch(event)">
          <input type="text" id="navSearchInput" placeholder="Поиск @username..." value="${esc(searchDefault)}" />
        </form>
      </div>
      <div class="navbar-actions">
        <a href="https://t.me/${esc(tgUser)}" target="_blank" rel="noopener" class="tg-btn">
          ${SVG_ICONS.telegram}
          <span>Бот в Telegram</span>
        </a>
      </div>
    </header>
  `;
}

function renderPromoBanner(username?: string): string {
  const tgLink = username ? `https://t.me/threads_reader_bot?start=sub_${username}` : "https://t.me/threads_reader_bot";
  return `
    <aside class="promo-bar" aria-label="Telegram Bot Notice">
      <span>🚀 Читайте Threads без VPN и ограничений прямо в Telegram!</span>
      <a href="${esc(tgLink)}" target="_blank" rel="noopener">Открыть бота</a>
    </aside>
  `;
}

function renderAdSlot(): string {
  return `
    <div class="ad-box" role="complementary" aria-label="Спонсорский блок">
      <div class="ad-label">
        <span>⚡️ Спонсорский блок</span>
        <a href="https://t.me/threads_reader_bot" target="_blank" rel="noopener" style="font-size: 0.68rem; color: #7d8590; text-decoration: underline;">Разместить рекламу</a>
      </div>
      <div class="ad-content">
        <div class="ad-text">
          <h4>Надоело открывать через браузер?</h4>
          <p>Быстрый доступ к Threads и Instagram в приложении без тормозов и ограничений.</p>
        </div>
        <a href="https://t.me/threads_reader_bot" target="_blank" rel="noopener" class="ad-button">
          Подключить доступ
        </a>
      </div>
    </div>
  `;
}

export function renderHomePage(env: Env): Response {
  const tgUser = getBotUsername(env);
  const popular = ["durov", "mosseri", "zuck", "mrbeast", "openai", "techcrunch", "nasa"];
  const chipsHtml = popular
    .map(name => `<a href="/@${name}" class="popular-chip">@${name}</a>`)
    .join("");

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Threads Viewer — Читать Threads без VPN и регистрации онлайн</title>
  <meta name="description" content="Бесплатное анонимное веб-зеркало Threads. Читайте посты, смотрите фото, видео и комментарии любых профилей без VPN, блокировок и регистрации.">
  <meta property="og:title" content="Threads Viewer — Читать Threads без VPN">
  <meta property="og:description" content="Анонимный просмотр постов и комментариев Threads без VPN и регистрации.">
  <meta property="og:type" content="website">
  <meta name="theme-color" content="#101010">
  <style>${COMMON_STYLES}</style>
</head>
<body>
  ${renderNavbar(env)}
  ${renderPromoBanner()}

  <main class="container">
    <section class="hero">
      <div class="hero-badge">
        <span>🛡 100% Анонимно • Без VPN • Без регистрации</span>
      </div>
      <h1 class="hero-title">Читайте Threads без VPN и блокировок</h1>
      <p class="hero-subtitle">
        Введите никнейм автора или ссылку на пост, чтобы свободно читать треды, смотреть фото и комментарии прямо в браузере.
      </p>

      <form class="hero-search-box" onsubmit="handleHeroSearch(event)">
        <span style="display:flex; color:#888;">${SVG_ICONS.search}</span>
        <input type="text" id="heroSearchInput" placeholder="Введите @username или threads.com/@..." autofocus />
        <button type="submit">Открыть</button>
      </form>

      <div class="popular-chips">
        ${chipsHtml}
      </div>
    </section>

    ${renderAdSlot()}

    <section class="features-grid">
      <div class="feature-card">
        <div class="feature-icon">🛡️</div>
        <h3 class="feature-title">Работает без VPN</h3>
        <p class="feature-desc">Все страницы, тексты и медиа загружаются напрямую через безопасные серверы Cloudflare без блокировок.</p>
      </div>

      <div class="feature-card">
        <div class="feature-icon">👁️</div>
        <h3 class="feature-title">Полная анонимность</h3>
        <p class="feature-desc">Вам не нужен аккаунт Threads или Instagram. Авторы публикаций никогда не узнают, что вы смотрели их профиль.</p>
      </div>

      <div class="feature-card">
        <div class="feature-icon">⚡️</div>
        <h3 class="feature-title">Быстро и удобно</h3>
        <p class="feature-desc">Кеширование постов обеспечивает мгновенное открытие страниц, как в обычном приложении Threads.</p>
      </div>

      <div class="feature-card">
        <div class="feature-icon">📲</div>
        <h3 class="feature-title">Telegram-бот</h3>
        <p class="feature-desc">Получайте мгновенные уведомления о свежих тредах избранных блогеров в нашем Telegram-боте.</p>
      </div>
    </section>

    <div class="ad-box" style="background: linear-gradient(135deg, #1c2b3e 0%, #16202c 100%); border-color: #2b4363;">
      <div class="ad-label">
        <span>Уведомления в Telegram</span>
      </div>
      <div class="ad-content">
        <div class="ad-text">
          <h4>Хотите следить за новыми тредами?</h4>
          <p>Бот пришлёт свежий пост автора через секунды после публикации.</p>
        </div>
        <a href="https://t.me/${esc(tgUser)}" target="_blank" rel="noopener" class="ad-button" style="background: var(--accent-tg);">
          Запустить бота
        </a>
      </div>
    </div>
  </main>

  <footer class="footer">
    <div class="footer-links">
      <a href="/">Главная</a>
      <a href="https://t.me/${esc(tgUser)}" target="_blank" rel="noopener">Telegram Бот</a>
      <a href="/terms">Правила</a>
      <a href="/privacy">Конфиденциальность</a>
    </div>
    <p>© ${new Date().getFullYear()} Threads Viewer. Независимый сервис. Не аффилирован с Meta Platforms Inc.</p>
  </footer>

  <div id="toast" class="toast"></div>

  <script>
    function showToast(msg) {
      var t = document.getElementById('toast');
      t.innerText = msg;
      t.classList.add('show');
      setTimeout(function() { t.classList.remove('show'); }, 2500);
    }
    function cleanUsername(raw) {
      var clean = (raw || '').trim();
      var match = clean.match(/(?:threads\\.(?:com|net)\\/)?@?([A-Za-z0-9._]+)/);
      return match ? match[1] : '';
    }
    function handleHeroSearch(e) {
      e.preventDefault();
      var input = document.getElementById('heroSearchInput');
      var name = cleanUsername(input.value);
      if (name) {
        window.location.href = '/@' + name;
      } else {
        showToast('Пожалуйста, введите корректный @username');
      }
    }
    function handleNavSearch(e) {
      e.preventDefault();
      var input = document.getElementById('navSearchInput');
      var name = cleanUsername(input.value);
      if (name) {
        window.location.href = '/@' + name;
      }
    }
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": "public, max-age=3600, stale-while-revalidate=86400",
    },
  });
}

export function renderProfilePage(
  env: Env,
  username: string,
  initialData?: ProfileData | null,
  errorMessage?: string | null
): Response {
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
  const hasData = Boolean(initialData && posts.length > 0);

  const postsHtml = posts.map((post, idx) => {
    const postDate = post.date || "";
    const authorName = post.author || profile.displayName || cleanUser;
    const authorAvatar = post.authorAvatar || profile.avatar || "";

    const mediaHtml = post.imageUrl
      ? `<div class="post-media">
          <img src="${esc(post.imageUrl)}" data-orig="${esc(post.imageUrl)}" alt="Post image" loading="lazy" onclick="openLightbox('${esc(post.imageUrl)}')" onerror="if(!this.dataset.proxy){this.dataset.proxy='1';this.src='/api/img?url='+encodeURIComponent(this.getAttribute('data-orig'));}" />
        </div>`
      : "";

    const videoBadge = post.has_video
      ? `<div class="post-video-badge">▶ Видеозапись</div>`
      : "";

    return `
      <article class="post-card" id="post-${idx}">
        <div class="post-header">
          <div class="post-author">
            ${authorAvatar ? `<img src="${esc(authorAvatar)}" class="post-avatar" alt="${esc(authorName)}" loading="lazy" />` : `<div class="post-avatar" style="display:flex;align-items:center;justify-content:center;color:#888;">@</div>`}
            <div>
              <a href="/@${esc(cleanUser)}" class="post-author-name">
                ${esc(authorName)}
                ${profile.verified ? SVG_ICONS.verified : ""}
              </a>
              ${postDate ? `<div class="post-date">${esc(postDate)}</div>` : ""}
            </div>
          </div>
          <button class="post-action-btn" title="Скопировать ссылку" onclick="copyPostLink('${esc(cleanUser)}', ${idx})">
            ${SVG_ICONS.share}
          </button>
        </div>

        <div class="post-body">
          ${formatPostText(post.text)}
        </div>

        ${videoBadge}
        ${mediaHtml}

        <div class="post-actions">
          <button class="post-action-btn" onclick="toggleLike(this)">
            ${SVG_ICONS.heart}
            <span class="like-count">Нравится</span>
          </button>
          <button class="post-action-btn" onclick="toggleComments('${esc(cleanUser)}', ${idx})">
            ${SVG_ICONS.comment}
            <span>Комментарии</span>
          </button>
          <a href="https://t.me/${esc(tgUser)}?start=sub_${esc(cleanUser)}" target="_blank" rel="noopener" class="post-action-btn" style="margin-left:auto;">
            ${SVG_ICONS.telegram}
            <span>В бот</span>
          </a>
        </div>

        <div class="comments-container" id="comments-${idx}">
          <div class="loading-spinner" style="padding:16px;">
            <div class="spinner" style="width:20px;height:20px;border-width:2px;"></div>
            <span>Загрузка комментариев...</span>
          </div>
        </div>
      </article>
    `;
  }).join("");

  const pageTitle = `@${esc(cleanUser)} в Threads — читать посты без VPN онлайн | Threads Viewer`;
  const pageDesc = profile.bio
    ? `Смотрите посты, фото и комментарии @${esc(cleanUser)} в Threads без регистрации и VPN: ${esc(profile.bio.slice(0, 120))}`
    : `Смотреть последние посты, фото и комментарии @${esc(cleanUser)} в Threads без регистрации и VPN.`;

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle}</title>
  <meta name="description" content="${pageDesc}">
  <meta property="og:title" content="@${esc(cleanUser)} в Threads">
  <meta property="og:description" content="${pageDesc}">
  ${profile.avatar ? `<meta property="og:image" content="${esc(profile.avatar)}">` : ""}
  <meta property="og:type" content="profile">
  <meta name="theme-color" content="#101010">
  <style>${COMMON_STYLES}</style>
</head>
<body>
  ${renderNavbar(env, "@" + cleanUser)}
  ${renderPromoBanner(cleanUser)}

  <main class="container">
    <section class="profile-header-card">
      <div class="profile-top">
        <div class="profile-names">
          <h1 class="profile-display-name">
            ${esc(profile.displayName)}
            ${profile.verified ? SVG_ICONS.verified : ""}
          </h1>
          <div class="profile-username">
            <span>@${esc(cleanUser)}</span>
            <span class="threads-tag">threads.com</span>
          </div>
        </div>
        <div class="profile-avatar-wrap">
          ${profile.avatar
            ? `<img src="${esc(profile.avatar)}" class="profile-avatar" alt="${esc(cleanUser)}" onerror="this.style.display='none'" />`
            : `<div class="profile-avatar" style="display:flex;align-items:center;justify-content:center;font-size:32px;color:#888;">@</div>`}
        </div>
      </div>

      ${profile.bio ? `<div class="profile-bio">${formatPostText(profile.bio)}</div>` : ""}

      <div class="profile-meta-row">
        ${profile.followers ? `<span>👥 <b>${esc(profile.followers)}</b></span>` : ""}
        <span>🌐 <b>Без VPN</b></span>
        <span>🔒 <b>Анонимный просмотр</b></span>
      </div>

      <div class="profile-actions">
        <a href="https://t.me/${esc(tgUser)}?start=sub_${esc(cleanUser)}" target="_blank" rel="noopener" class="btn btn-tg">
          ${SVG_ICONS.telegram}
          <span>Подписаться в Telegram</span>
        </a>
        <button class="btn btn-secondary" onclick="shareProfile()">
          ${SVG_ICONS.share}
          <span>Поделиться</span>
        </button>
      </div>
    </section>

    ${renderAdSlot()}

    <section class="feed" id="postsFeed">
      ${postsHtml}
    </section>

    <div id="loadingBox" class="loading-spinner" style="${hasData ? "display:none;" : ""}">
      <div class="spinner"></div>
      <p id="loadingStatusText">${errorMessage ? esc(errorMessage) : "Связываемся с Threads и загружаем свежие посты..."}</p>
    </div>

    ${!hasData && errorMessage ? `
      <div class="empty-state">
        <h3>Не удалось загрузить посты</h3>
        <p>${esc(errorMessage)}</p>
        <div style="margin-top: 16px;">
          <a href="https://t.me/${esc(tgUser)}?start=sub_${esc(cleanUser)}" class="btn btn-tg">
            ${SVG_ICONS.telegram}
            <span>Открыть в Telegram-боте</span>
          </a>
        </div>
      </div>
    ` : ""}

    <div style="text-align: center; margin: 28px 0;" id="loadMoreSection" style="${hasData ? "" : "display:none;"}">
      <button class="btn btn-secondary" style="width: 100%; max-width: 300px; justify-content: center;" onclick="loadMorePosts('${esc(cleanUser)}')">
        <span>Загрузить ещё посты</span>
      </button>
    </div>
  </main>

  <!-- Lightbox for images -->
  <div id="lightbox" class="lightbox" onclick="closeLightbox()">
    <button class="lightbox-close" onclick="closeLightbox()">&times;</button>
    <img id="lightboxImg" src="" alt="Fullscreen image" />
  </div>

  <div id="toast" class="toast"></div>

  <footer class="footer">
    <div class="footer-links">
      <a href="/">Главная</a>
      <a href="https://t.me/${esc(tgUser)}" target="_blank" rel="noopener">Telegram Бот</a>
      <a href="/terms">Правила</a>
      <a href="/privacy">Конфиденциальность</a>
    </div>
    <p>© ${new Date().getFullYear()} Threads Viewer. Независимый сервис. Не аффилирован с Meta Platforms Inc.</p>
  </footer>

  <script>
    var currentUsername = "${esc(cleanUser)}";
    var isLoaded = ${hasData ? "true" : "false"};

    function showToast(msg) {
      var t = document.getElementById('toast');
      t.innerText = msg;
      t.classList.add('show');
      setTimeout(function() { t.classList.remove('show'); }, 2500);
    }

    function shareProfile() {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(window.location.href);
        showToast('✓ Ссылка на профиль скопирована!');
      } else {
        showToast(window.location.href);
      }
    }

    function copyPostLink(username, idx) {
      var url = window.location.origin + '/@' + username + '#post-' + idx;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url);
        showToast('✓ Ссылка на пост скопирована!');
      }
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

    function toggleLike(btn) {
      btn.classList.toggle('liked');
      var count = btn.querySelector('.like-count');
      if (btn.classList.contains('liked')) {
        count.innerText = '1';
      } else {
        count.innerText = 'Нравится';
      }
    }

    function toggleComments(username, idx) {
      var container = document.getElementById('comments-' + idx);
      if (container.style.display === 'block') {
        container.style.display = 'none';
        return;
      }
      container.style.display = 'block';

      if (container.dataset.loaded) return;

      fetch('/api/comments/' + encodeURIComponent(username) + '/' + idx)
        .then(function(res) { return res.json(); })
        .then(function(data) {
          container.dataset.loaded = 'true';
          if (!data.ok || !data.comments || !data.comments.length) {
            container.innerHTML = '<div style="color:#777;font-size:0.85rem;padding:8px 0;">Комментариев пока нет.</div>';
            return;
          }
          var html = '';
          data.comments.forEach(function(c) {
            html += '<div class="comment-item">' +
              '<div class="comment-author">' + (c.author || '—') + '</div>' +
              '<div class="comment-text">' + (c.text || '') + '</div>' +
            '</div>';
          });
          container.innerHTML = html;
        })
        .catch(function(err) {
          container.innerHTML = '<div style="color:#e53e3e;font-size:0.85rem;padding:8px 0;">Не удалось загрузить комментарии.</div>';
        });
    }

    function handleNavSearch(e) {
      e.preventDefault();
      var input = document.getElementById('navSearchInput');
      var val = (input.value || '').trim().replace(/^@/, '');
      if (val) window.location.href = '/@' + val;
    }

    // Auto-fetch if not SSR loaded
    if (!isLoaded) {
      fetch('/api/profile/' + encodeURIComponent(currentUsername))
        .then(function(res) { return res.json(); })
        .then(function(res) {
          var loadingBox = document.getElementById('loadingBox');
          if (res.ok && res.posts && res.posts.length) {
            window.location.reload();
          } else {
            var txt = document.getElementById('loadingStatusText');
            if (txt) txt.innerText = res.error || 'Посты не найдены или аккаунты Threads недоступны.';
          }
        })
        .catch(function(err) {
          var txt = document.getElementById('loadingStatusText');
          if (txt) txt.innerText = 'Ошибка соединения при загрузке тредов.';
        });
    }

    function loadMorePosts(username) {
      showToast('Загружаем следующую порцию тредов...');
      fetch('/api/profile/' + encodeURIComponent(username) + '?page=1')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok && data.posts && data.posts.length) {
            showToast('✓ Посты обновлены');
          } else {
            showToast('Все доступные посты уже показаны.');
          }
        })
        .catch(function() {
          showToast('Не удалось загрузить ещё посты.');
        });
    }

    // Infinite scroll listener
    var scrollThrottle = false;
    window.addEventListener('scroll', function() {
      if (scrollThrottle) return;
      scrollThrottle = true;
      setTimeout(function() { scrollThrottle = false; }, 300);

      if ((window.innerHeight + window.scrollY) >= document.body.offsetHeight - 400) {
        var loadBtn = document.querySelector('#loadMoreSection button');
        if (loadBtn && !loadBtn.dataset.busy) {
          loadBtn.dataset.busy = '1';
          loadMorePosts(currentUsername);
        }
      }
    });
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": hasData ? "public, max-age=600, stale-while-revalidate=3600" : "no-cache",
    },
  });
}

export function renderTermsPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Пользовательское соглашение — Threads Viewer</title>
  <style>${COMMON_STYLES} .terms-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 20px; padding: 32px; margin: 30px auto; max-width: 700px; } .terms-card h1 { margin-bottom: 16px; font-size: 1.8rem; } .terms-card h2 { margin: 20px 0 8px; font-size: 1.2rem; } .terms-card p { color: var(--text-secondary); margin-bottom: 12px; font-size: 0.92rem; }</style>
</head>
<body>
  <div class="terms-card">
    <h1>Пользовательское соглашение</h1>
    <p>Дата обновления: 2026-09-20</p>

    <h2>1. Общие положения</h2>
    <p>Threads Viewer — это независимый веб-просмотрщик общедоступных данных платформы Threads, предназначенный для чтения открытых публикаций в ознакомительных целях.</p>

    <h2>2. Отказ от ответственности</h2>
    <p>Сервис не связан с Meta Platforms Inc., Instagram или Threads. Все товарные знаки и авторские права на материалы принадлежат их законным правообладателям.</p>

    <h2>3. Использование сервиса</h2>
    <p>Сервис предоставляется по принципу «как есть» (as is). Мы не несем ответственности за содержание постов третьих лиц, публикуемых на внешней платформе Threads.</p>

    <div style="margin-top: 24px;">
      <a href="/" class="btn btn-secondary">← Вернуться на главную</a>
    </div>
  </div>
</body>
</html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=UTF-8" } });
}

export function renderPrivacyPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Политика конфиденциальности — Threads Viewer</title>
  <style>${COMMON_STYLES} .terms-card { background: var(--bg-card); border: 1px solid var(--border); border-radius: 20px; padding: 32px; margin: 30px auto; max-width: 700px; } .terms-card h1 { margin-bottom: 16px; font-size: 1.8rem; } .terms-card h2 { margin: 20px 0 8px; font-size: 1.2rem; } .terms-card p { color: var(--text-secondary); margin-bottom: 12px; font-size: 0.92rem; }</style>
</head>
<body>
  <div class="terms-card">
    <h1>Политика конфиденциальности</h1>
    <p>Дата обновления: 2026-09-20</p>

    <h2>1. Сбор информации</h2>
    <p>Threads Viewer не требует регистрации, авторизации, ввода паролей или личных данных. Мы не собираем персональную информацию посетителей сайта.</p>

    <h2>2. Файлы Cookie</h2>
    <p>Сервис не сохраняет постоянные отслеживающие cookie пользователей. Все запросы к публичным профилям обрабатываются анонимно.</p>

    <h2>3. Безопасность</h2>
    <p>Все сетевые соединения защищены современными стандартами шифрования HTTPS / TLS.</p>

    <div style="margin-top: 24px;">
      <a href="/" class="btn btn-secondary">← Вернуться на главную</a>
    </div>
  </div>
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
    `${origin}/terms`,
    `${origin}/privacy`,
    ...popularProfiles.map(u => `${origin}/@${u}`),
  ];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${esc(u)}</loc>
    <changefreq>daily</changefreq>
    <priority>${u.endsWith('/') ? '1.0' : '0.8'}</priority>
  </url>`).join("\n")}
</urlset>`;

  return new Response(xml, { headers: { "content-type": "application/xml; charset=UTF-8" } });
}

export async function handleImageProxy(request: Request): Promise<Response> {
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

  // SSRF Protection: Only allow Meta/Instagram/Threads CDN domains
  const host = parsed.hostname.toLowerCase();
  const isAllowed = host.endsWith(".cdninstagram.com") || host.endsWith(".fbcdn.net") || host.endsWith(".threads.net");
  if (!isAllowed) {
    return new Response("Forbidden host", { status: 403 });
  }

  try {
    const upstream = await fetch(urlParam, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Referer": "https://www.threads.com/",
        "Accept": "image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8",
      },
    });

    if (!upstream.ok) {
      return new Response("Upstream image error", { status: upstream.status });
    }

    const contentType = upstream.headers.get("content-type") || "image/jpeg";
    return new Response(upstream.body, {
      status: 200,
      headers: {
        "content-type": contentType,
        "cache-control": "public, max-age=604800, stale-while-revalidate=2592000",
      },
    });
  } catch (err) {
    return new Response("Failed to fetch image", { status: 502 });
  }
}
