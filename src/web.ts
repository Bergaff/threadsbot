import type { Env } from "./config";
import type { Comment, Post, ProfileData } from "./threads";

function esc(value: unknown): string {
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

function getBotUsername(env: Env): string {
  return "threads_reader_bot";
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
    max-width: 380px;
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
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .btn-nav-tg {
    background: #2a2a2a;
    border: 1px solid #3d3d3d;
    color: #ffffff;
    padding: 6px 12px;
    border-radius: 0;
    font-size: 0.82rem;
    font-weight: 600;
    box-shadow: none;
  }

  /* Notice Bar */
  .notice-bar {
    background: #1c1c1c;
    border-bottom: 1px solid #2d2d2d;
    color: #b0b0b0;
    font-size: 0.82rem;
    text-align: center;
    padding: 8px 12px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 12px;
    flex-wrap: wrap;
    box-shadow: none;
  }
  .notice-bar a {
    background: #2b2b2b;
    border: 1px solid #444444;
    color: #ffffff;
    padding: 2px 8px;
    border-radius: 0;
    font-size: 0.78rem;
    font-weight: 600;
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
    margin-bottom: 14px;
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

  .chips-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 10px;
  }
  .chip-btn {
    background: #1b1b1b;
    border: 1px solid #2d2d2d;
    border-radius: 0;
    padding: 4px 10px;
    font-size: 0.8rem;
    color: #999999;
    box-shadow: none;
  }
  .chip-btn:hover {
    color: #ffffff;
    border-color: #555555;
    background: #242424;
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
  .video-indicator {
    display: inline-block;
    border: 1px solid #333333;
    background: #1c1c1c;
    padding: 2px 6px;
    font-size: 0.72rem;
    color: #aaaaaa;
    margin-bottom: 8px;
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

  /* Comments */
  .comments-box {
    margin-top: 10px;
    padding-top: 10px;
    border-top: 1px solid #202020;
    display: none;
  }
  .comment-row {
    padding: 6px 0;
    border-bottom: 1px solid #1c1c1c;
    font-size: 0.82rem;
  }
  .comment-row:last-child { border-bottom: none; }
  .comment-author-name {
    font-weight: 700;
    color: #ffffff;
    margin-bottom: 2px;
  }
  .comment-content {
    color: #b5b5b5;
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

  /* Status message */
  .status-message {
    text-align: center;
    padding: 24px 12px;
    color: #777777;
    font-size: 0.88rem;
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

  @media (max-width: 600px) {
    .navbar-search { display: none; }
    .hero-title { font-size: 1.3rem; }
  }
`;

function renderNavbar(env: Env, searchDefault = ""): string {
  const tgUser = getBotUsername(env);
  return `
    <header class="navbar">
      <a href="/" class="navbar-brand">
        <span>Threads Viewer</span>
      </a>
      <div class="navbar-search">
        <form onsubmit="handleNavSearch(event)">
          <input type="text" id="navSearchInput" placeholder="Поиск @username..." value="${esc(searchDefault)}" />
        </form>
      </div>
      <div class="navbar-actions">
        <a href="https://t.me/${esc(tgUser)}" target="_blank" rel="noopener" class="btn-nav-tg">
          Telegram Бот
        </a>
      </div>
    </header>
  `;
}

function renderNoticeBar(username?: string): string {
  const tgLink = username ? `https://t.me/threads_reader_bot?start=sub_${username}` : "https://t.me/threads_reader_bot";
  return `
    <div class="notice-bar">
      <span>Чтение Threads без VPN и аккаунта. Уведомления о новых постах доступны в Telegram-боте.</span>
      <a href="${esc(tgLink)}" target="_blank" rel="noopener">Открыть бота</a>
    </div>
  `;
}

function renderSponsorSlot(): string {
  return `
    <div class="sponsor-card">
      <div class="sponsor-card-top">
        <span>Партнерский блок</span>
        <a href="https://t.me/threads_reader_bot" target="_blank" rel="noopener" style="color: #777; text-decoration: underline;">Реклама</a>
      </div>
      <div class="sponsor-card-inner">
        <div class="sponsor-text">
          <h4>Доступ к Threads и Instagram без ограничений</h4>
          <p>Быстрый доступ к приложениям Meta на ПК и телефоне без зависаний.</p>
        </div>
        <a href="https://t.me/threads_reader_bot" target="_blank" rel="noopener" class="sponsor-btn">
          Подробнее
        </a>
      </div>
    </div>
  `;
}

export function renderHomePage(env: Env): Response {
  const tgUser = getBotUsername(env);
  const popular = ["durov", "mosseri", "zuck", "mrbeast", "openai", "techcrunch"];
  const chipsHtml = popular
    .map(name => `<a href="/@${name}" class="chip-btn">@${name}</a>`)
    .join("");

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Threads Viewer - Читайте Threads без VPN онлайн</title>
  <meta name="description" content="Веб-зеркало для чтения постов, просмотра медиа и комментариев Threads без VPN и регистрации.">
  <style>${COMMON_STYLES}</style>
</head>
<body>
  ${renderNavbar(env)}
  ${renderNoticeBar()}

  <main class="container">
    <div class="hero-card">
      <div class="hero-tag">Анонимное веб-зеркало</div>
      <h1 class="hero-title">Читайте Threads без VPN</h1>
      <p class="hero-subtitle">
        Введите никнейм автора или ссылку на тред, чтобы открыть посты, фото и комментарии прямо в браузере.
      </p>

      <form class="hero-search-form" onsubmit="handleHeroSearch(event)">
        <input type="text" id="heroSearchInput" placeholder="Введите @username или threads.com/@..." autofocus />
        <button type="submit">Открыть</button>
      </form>

      <div class="chips-row">
        ${chipsHtml}
      </div>
    </div>

    ${renderSponsorSlot()}
  </main>

  <footer class="footer-block">
    <div class="footer-links-row">
      <a href="/">Главная</a>
      <a href="https://t.me/${esc(tgUser)}" target="_blank" rel="noopener">Telegram Бот</a>
      <a href="/terms">TOS</a>
      <a href="/privacy">Privacy Policy</a>
    </div>
    <p>Threads Viewer. Независимый сервис. Не аффилирован с Meta Platforms Inc.</p>
  </footer>

  <div id="toast" class="toast-box"></div>

  <script>
    function showToast(msg) {
      var t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(function() { t.style.display = 'none'; }, 2200);
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
        showToast('Введите корректный @username');
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
      "cache-control": "public, max-age=3600",
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
      ? `<div class="post-media-box">
          <img src="${esc(post.imageUrl)}" data-orig="${esc(post.imageUrl)}" alt="Post image" onclick="openLightbox('${esc(post.imageUrl)}')" onerror="if(!this.dataset.proxy){this.dataset.proxy='1';this.src='/api/img?url='+encodeURIComponent(this.getAttribute('data-orig'));}" />
        </div>`
      : "";

    const videoMarker = post.has_video
      ? `<span class="video-indicator">Видеозапись</span>`
      : "";

    return `
      <article class="post-card" id="post-${idx}">
        <div class="post-card-top">
          <div class="post-author-block">
            ${authorAvatar ? `<img src="${esc(authorAvatar)}" class="post-author-avatar" alt="${esc(authorName)}" />` : `<div class="post-author-avatar" style="display:flex;align-items:center;justify-content:center;color:#666;font-size:11px;">@</div>`}
            <div>
              <a href="/@${esc(cleanUser)}" class="post-author-handle">${esc(authorName)}</a>
              ${postDate ? `<div class="post-timestamp">${esc(postDate)}</div>` : ""}
            </div>
          </div>
          <button class="toolbar-btn" title="Ссылка на пост" onclick="copyPostLink('${esc(cleanUser)}', ${idx})">
            Поделиться
          </button>
        </div>

        <div class="post-body-text">
          ${formatPostText(post.text)}
        </div>

        ${videoMarker}
        ${mediaHtml}

        <div class="post-toolbar">
          <button class="toolbar-btn" onclick="toggleLike(this)">
            <span class="like-label">Нравится</span>
          </button>
          <button class="toolbar-btn" onclick="toggleComments('${esc(cleanUser)}', ${idx})">
            Комментарии
          </button>
          <a href="https://t.me/${esc(tgUser)}?start=sub_${esc(cleanUser)}" target="_blank" rel="noopener" class="toolbar-btn" style="margin-left:auto;">
            В бот
          </a>
        </div>

        <div class="comments-box" id="comments-${idx}">
          <div style="font-size:0.8rem;color:#777;padding:6px 0;">Загрузка комментариев...</div>
        </div>
      </article>
    `;
  }).join("");

  const pageTitle = `@${esc(cleanUser)} в Threads - читать без VPN | Threads Viewer`;

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${pageTitle}</title>
  <meta name="description" content="Посты, фото и комментарии @${esc(cleanUser)} в Threads без регистрации и VPN.">
  <style>${COMMON_STYLES}</style>
</head>
<body>
  ${renderNavbar(env, "@" + cleanUser)}
  ${renderNoticeBar(cleanUser)}

  <main class="container">
    <div class="profile-card">
      <div class="profile-top-row">
        <div class="profile-title-block">
          <h1 class="profile-name">${esc(profile.displayName)}</h1>
          <div class="profile-handle">@${esc(cleanUser)} (threads.com)</div>
        </div>
        <div class="profile-avatar-box">
          ${profile.avatar
            ? `<img src="${esc(profile.avatar)}" class="profile-avatar-img" alt="${esc(cleanUser)}" onerror="this.style.display='none'" />`
            : `<div class="profile-avatar-img" style="display:flex;align-items:center;justify-content:center;color:#666;font-size:24px;">@</div>`}
        </div>
      </div>

      ${profile.bio ? `<div class="profile-bio">${formatPostText(profile.bio)}</div>` : ""}

      <div class="profile-stats-row">
        ${profile.followers ? `<span>Подписчики: ${esc(profile.followers)}</span>` : ""}
        <span>Без VPN</span>
        <span>Анонимный просмотр</span>
      </div>

      <div class="profile-actions">
        <a href="https://t.me/${esc(tgUser)}?start=sub_${esc(cleanUser)}" target="_blank" rel="noopener" class="btn-sharp">
          Подписаться в Telegram
        </a>
        <button class="btn-sharp" onclick="shareProfile()">
          Поделиться профилем
        </button>
      </div>
    </div>

    ${renderSponsorSlot()}

    <section class="feed" id="postsFeed">
      ${postsHtml}
    </section>

    <div id="loadingBox" class="status-message" style="${hasData ? "display:none;" : ""}">
      <p id="loadingStatusText">${errorMessage ? esc(errorMessage) : "Загрузка постов из Threads..."}</p>
    </div>

    <div style="text-align: center; margin: 20px 0;" id="loadMoreSection" style="${hasData ? "" : "display:none;"}">
      <button class="btn-sharp" style="width: 100%; max-width: 260px; justify-content: center;" onclick="loadMorePosts('${esc(cleanUser)}')">
        Загрузить еще посты
      </button>
    </div>
  </main>

  <div id="lightbox" class="lightbox-overlay" onclick="closeLightbox()">
    <button class="lightbox-close-btn" onclick="closeLightbox()">&times;</button>
    <img id="lightboxImg" src="" alt="View image" />
  </div>

  <div id="toast" class="toast-box"></div>

  <footer class="footer-block">
    <div class="footer-links-row">
      <a href="/">Главная</a>
      <a href="https://t.me/${esc(tgUser)}" target="_blank" rel="noopener">Telegram Бот</a>
      <a href="/terms">TOS</a>
      <a href="/privacy">Privacy Policy</a>
    </div>
    <p>Threads Viewer. Независимый сервис. Не аффилирован с Meta Platforms Inc.</p>
  </footer>

  <script>
    var currentUsername = "${esc(cleanUser)}";
    var isLoaded = ${hasData ? "true" : "false"};

    function showToast(msg) {
      var t = document.getElementById('toast');
      t.innerText = msg;
      t.style.display = 'block';
      setTimeout(function() { t.style.display = 'none'; }, 2000);
    }

    function shareProfile() {
      if (navigator.clipboard) {
        navigator.clipboard.writeText(window.location.href);
        showToast('Ссылка скопирована');
      } else {
        showToast(window.location.href);
      }
    }

    function copyPostLink(username, idx) {
      var url = window.location.origin + '/@' + username + '#post-' + idx;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(url);
        showToast('Ссылка на пост скопирована');
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
      btn.classList.toggle('active');
      var label = btn.querySelector('.like-label');
      label.innerText = btn.classList.contains('active') ? 'Нравится (1)' : 'Нравится';
    }

    function toggleComments(username, idx) {
      var box = document.getElementById('comments-' + idx);
      if (box.style.display === 'block') {
        box.style.display = 'none';
        return;
      }
      box.style.display = 'block';

      if (box.dataset.loaded) return;

      fetch('/api/comments/' + encodeURIComponent(username) + '/' + idx)
        .then(function(res) { return res.json(); })
        .then(function(data) {
          box.dataset.loaded = 'true';
          if (!data.ok || !data.comments || !data.comments.length) {
            box.innerHTML = '<div style="color:#777;font-size:0.8rem;padding:4px 0;">Комментариев нет.</div>';
            return;
          }
          var html = '';
          data.comments.forEach(function(c) {
            html += '<div class="comment-row">' +
              '<div class="comment-author-name">' + (c.author || '-') + '</div>' +
              '<div class="comment-content">' + (c.text || '') + '</div>' +
            '</div>';
          });
          box.innerHTML = html;
        })
        .catch(function() {
          box.innerHTML = '<div style="color:#aa4444;font-size:0.8rem;padding:4px 0;">Не удалось загрузить комментарии.</div>';
        });
    }

    function handleNavSearch(e) {
      e.preventDefault();
      var input = document.getElementById('navSearchInput');
      var val = (input.value || '').trim().replace(/^@/, '');
      if (val) window.location.href = '/@' + val;
    }

    if (!isLoaded) {
      fetch('/api/profile/' + encodeURIComponent(currentUsername))
        .then(function(res) { return res.json(); })
        .then(function(res) {
          if (res.ok && res.posts && res.posts.length) {
            window.location.reload();
          } else {
            var txt = document.getElementById('loadingStatusText');
            if (txt) txt.innerText = res.error || 'Посты не найдены.';
          }
        })
        .catch(function() {
          var txt = document.getElementById('loadingStatusText');
          if (txt) txt.innerText = 'Ошибка соединения.';
        });
    }

    function loadMorePosts(username) {
      showToast('Загрузка постов...');
      fetch('/api/profile/' + encodeURIComponent(username) + '?page=1')
        .then(function(r) { return r.json(); })
        .then(function(data) {
          if (data.ok && data.posts && data.posts.length) {
            showToast('Посты обновлены');
          } else {
            showToast('Все посты загружены');
          }
        })
        .catch(function() {
          showToast('Не удалось загрузить');
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
</body>
</html>`;

  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=UTF-8",
      "cache-control": hasData ? "public, max-age=600" : "no-cache",
    },
  });
}

export function renderTermsPage(): Response {
  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terms of Service - Threads Viewer</title>
  <style>${COMMON_STYLES} .terms-card { background: #131313; border: 1px solid #2d2d2d; border-radius: 0; padding: 24px; margin: 30px auto; max-width: 680px; } .terms-card h1 { margin-bottom: 12px; font-size: 1.4rem; color: #fff; } .terms-card h2 { margin: 18px 0 6px; font-size: 1.05rem; color: #eee; } .terms-card p { color: #888888; margin-bottom: 10px; font-size: 0.88rem; }</style>
</head>
<body>
  <div class="terms-card">
    <h1>Terms of Service (Пользовательское соглашение)</h1>
    <p>Дата обновления: 2026-09-20</p>

    <h2>1. Общие положения</h2>
    <p>Threads Viewer - независимый веб-просмотрщик общедоступных данных платформы Threads, предназначенный для чтения открытых публикаций в ознакомительных целях.</p>

    <h2>2. Отказ от ответственности</h2>
    <p>Сервис не связан с Meta Platforms Inc., Instagram или Threads. Все товарные знаки принадлежат их правообладателям.</p>

    <h2>3. Использование сервиса</h2>
    <p>Сервис предоставляется по принципу "как есть" (as is). Администрация не несет ответственности за материалы третьих лиц.</p>

    <div style="margin-top: 20px;">
      <a href="/" class="btn-sharp">Вернуться на главную</a>
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
  <title>Privacy Policy - Threads Viewer</title>
  <style>${COMMON_STYLES} .terms-card { background: #131313; border: 1px solid #2d2d2d; border-radius: 0; padding: 24px; margin: 30px auto; max-width: 680px; } .terms-card h1 { margin-bottom: 12px; font-size: 1.4rem; color: #fff; } .terms-card h2 { margin: 18px 0 6px; font-size: 1.05rem; color: #eee; } .terms-card p { color: #888888; margin-bottom: 10px; font-size: 0.88rem; }</style>
</head>
<body>
  <div class="terms-card">
    <h1>Privacy Policy (Политика конфиденциальности)</h1>
    <p>Дата обновления: 2026-09-20</p>

    <h2>1. Сбор информации</h2>
    <p>Threads Viewer не требует регистрации, авторизации, ввода паролей или личных данных. Мы не собираем персональную информацию посетителей сайта.</p>

    <h2>2. Файлы Cookie</h2>
    <p>Сервис не использует постоянные отслеживающие cookie. Все запросы обрабатываются анонимно.</p>

    <h2>3. Безопасность</h2>
    <p>Все сетевые соединения защищены современными стандартами HTTPS и TLS.</p>

    <div style="margin-top: 20px;">
      <a href="/" class="btn-sharp">Вернуться на главную</a>
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
  } catch {
    return new Response("Failed to fetch image", { status: 502 });
  }
}
