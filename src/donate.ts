/**
 * Рекламная заглушка и добровольные пожертвования.
 * Чистый модуль без импорта web.ts (web.ts собирает из этих кусков полные страницы).
 *
 * - Сторонней рекламы на сайте нет. Вместо рекламного блока - заглушка
 *   «Здесь может быть ваша реклама» с контактами (почта и Telegram-бот).
 * - Сайт бесплатный. Пожертвование ДОБРОВОЛЬНОЕ и ничего не открывает.
 * - Оплата картой/СБП - касса RollyPay (src/rollypay.ts); без ключа кассы - заглушка. Stars и USDT - через бота.
 */
import { DONATIONS, botDonateLink, donationPrice, type Donation, type PayMethod } from "./plans";

type Lang = "ru" | "en";

export const ADS_EMAIL = "silviojurk70@gmail.com";

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

export const DONATE_CSS = `
  .ad-placeholder { margin: 18px 0; padding: 16px 18px; border: 1px dashed #3a3a3a; background: #121212; display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; text-align: left; }
  .ad-placeholder-tag { font-size: 0.68rem; text-transform: uppercase; letter-spacing: 0.6px; color: #6b7280; margin-bottom: 4px; }
  .ad-placeholder-title { font-size: 0.98rem; font-weight: 700; color: #e5e7eb; }
  .ad-placeholder-desc { font-size: 0.8rem; color: #9ca3af; margin-top: 3px; }
  .ad-placeholder-actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .ad-placeholder-actions a { padding: 7px 12px; font-size: 0.82rem; font-weight: 700; text-decoration: none; border: 1px solid #3a3a3a; color: #e5e7eb !important; background: #1c1c1c; white-space: nowrap; }
  .ad-placeholder-actions a:hover { border-color: #60a5fa; }
  .btn-nav-donate { color: #fbbf24 !important; border-color: #6b5a1e !important; }
  .donate { max-width: 760px; margin: 28px auto; display: grid; grid-template-columns: 1fr 1.2fr; gap: 16px; text-align: left; }
  .donate-box { background: #141414; border: 1px solid #282828; padding: 20px; }
  .donate-box h1, .donate-box h2 { font-size: 1.12rem; color: #fff; margin: 0 0 12px; }
  .donate-box p { color: #cbd5e1; font-size: 0.88rem; line-height: 1.55; margin: 0 0 10px; }
  .donate-note { font-size: 0.8rem !important; color: #9ca3af !important; border-left: 2px solid #3b82f6; padding-left: 10px; }
  .donate-amounts { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 6px; margin: 4px 0 14px; }
  .donate-amounts a { text-align: center; padding: 10px 4px; border: 1px solid #333; color: #e5e7eb; font-weight: 800; font-size: 0.95rem; text-decoration: none; background: #181818; }
  .donate-amounts a.on { border-color: #3b82f6; background: #172554; color: #fff; }
  .pay-method { display: flex; gap: 10px; align-items: flex-start; padding: 11px 12px; border: 1px solid #2a2a2a; background: #181818; margin-bottom: 8px; cursor: pointer; }
  .pay-method:has(input:checked) { border-color: #3b82f6; background: #111a2e; }
  .pay-method input { margin-top: 3px; accent-color: #3b82f6; }
  .pay-method-title { font-weight: 700; color: #fff; font-size: 0.9rem; }
  .pay-method-desc { display: block; font-size: 0.78rem; color: #9ca3af; margin-top: 2px; }
  .pay-submit { width: 100%; margin-top: 6px; padding: 12px; background: #2563eb; color: #fff; border: 0; font-weight: 800; font-size: 1rem; cursor: pointer; }
  .pay-submit:hover { background: #1d4ed8; }
  .pay-secure { font-size: 0.74rem; color: #6b7280; margin-top: 10px; text-align: center; }
  .pay-stub { max-width: 560px; margin: 36px auto; background: #141414; border: 1px solid #f59e0b; padding: 24px; text-align: left; }
  .pay-stub h1 { font-size: 1.15rem; color: #fff; margin: 0 0 10px; }
  .pay-stub p { color: #cbd5e1; font-size: 0.9rem; line-height: 1.5; margin: 8px 0; }
  .pay-stub .alt { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
  .pay-stub .alt a { flex: 1; min-width: 200px; text-align: center; padding: 10px; background: #2563eb; color: #fff !important; font-weight: 700; text-decoration: none; }
  .pay-stub .alt a.sec { background: #262626; border: 1px solid #3a3a3a; }
  .pay-stub.pay-ok { border-color: #22c55e; }
  @media (max-width: 820px) { .donate { grid-template-columns: 1fr; } }
  html[data-theme="light"] .ad-placeholder { background: #ddd5c7; border-color: #a99f8c; }
  html[data-theme="light"] .ad-placeholder-title { color: #1e1913; }
  html[data-theme="light"] .ad-placeholder-desc, html[data-theme="light"] .ad-placeholder-tag { color: #5c5346; }
  html[data-theme="light"] .ad-placeholder-actions a { background: #24201a; border-color: #24201a; color: #f7f4ee !important; }
  html[data-theme="light"] .btn-nav-donate { color: #8a5a00 !important; border-color: #b08a2e !important; }
  html[data-theme="light"] .donate-box, html[data-theme="light"] .pay-stub { background: #e6ded0; border-color: #b5ab99; }
  html[data-theme="light"] .pay-stub { border-color: #b7791f; }
  html[data-theme="light"] .pay-stub.pay-ok { border-color: #2f7d45; }
  html[data-theme="light"] .donate-box h1, html[data-theme="light"] .donate-box h2, html[data-theme="light"] .pay-method-title, html[data-theme="light"] .pay-stub h1 { color: #1e1913; }
  html[data-theme="light"] .donate-box p, html[data-theme="light"] .pay-stub p { color: #2e2820; }
  html[data-theme="light"] .donate-note, html[data-theme="light"] .pay-method-desc { color: #5c5346 !important; }
  html[data-theme="light"] .donate-amounts a, html[data-theme="light"] .pay-method { background: #ded5c6; border-color: #b8ad9b; color: #1e1913; }
  html[data-theme="light"] .donate-amounts a.on, html[data-theme="light"] .pay-method:has(input:checked) { border-color: #1a56a6; background: #d9d3cc; }
  html[data-theme="light"] .pay-stub .alt a.sec { background: #24201a; border-color: #24201a; color: #f7f4ee !important; }
`;

/** Заглушка рекламного места: «Здесь может быть ваша реклама». */
export function renderAdPlaceholder(lang: Lang, botUser: string): string {
  const isEn = lang === "en";
  const subject = encodeURIComponent(isEn ? "Advertising on threadsviewer.online" : "Реклама на threadsviewer.online");
  return `
    <div class="ad-placeholder" id="adPlaceholder">
      <div>
        <div class="ad-placeholder-tag">${isEn ? "Ad space" : "Рекламное место"}</div>
        <div class="ad-placeholder-title">${isEn ? "Your ad could be here" : "Здесь может быть ваша реклама"}</div>
        <div class="ad-placeholder-desc">${isEn ? "Interested in placing an ad? Write to us by email or in the Telegram bot." : "Хотите разместить рекламу? Напишите на почту или в Telegram-бот."}</div>
      </div>
      <div class="ad-placeholder-actions">
        <a href="mailto:${ADS_EMAIL}?subject=${subject}" rel="nofollow">${ADS_EMAIL}</a>
        <a href="https://t.me/${esc(botUser)}?start=ads" target="_blank" rel="noopener nofollow">${isEn ? "Write in Telegram" : "Написать в Telegram"}</a>
      </div>
    </div>`;
}

const D = {
  ru: {
    title: "Поддержать проект",
    intro: "Threads Viewer и Telegram-бот работают бесплатно. Если сервис вам полезен, можно поддержать его развитие и оплату серверов любой суммой.",
    note: "Пожертвование добровольное и ничего не открывает: все возможности сайта бесплатны для всех. Это просто ваше «спасибо».",
    amount: "Сумма",
    method: "Способ",
    card: "СБП / банковская карта",
    cardDesc: "Система быстрых платежей, МИР, Visa, Mastercard · платёжный сервис RollyPay",
    stars: "Telegram Stars",
    starsDesc: (n: number) => `${n} ⭐ · откроется Telegram-бот`,
    crypto: "Криптовалюта (USDT)",
    cryptoDesc: (n: number) => `${n} USDT через @CryptoBot`,
    submit: (s: string) => `Поддержать · ${s}`,
    secure: "Без подписки и автосписаний. Данные карт сайт не хранит.",
    thanks: "Спасибо всем, кто поддерживает проект!",
  },
  en: {
    title: "Support the project",
    intro: "Threads Viewer and the Telegram bot are free. If the service is useful to you, you can support its development and server costs with any amount.",
    note: "A donation is voluntary and unlocks nothing: every feature of the site is free for everyone. It is simply your thank-you.",
    amount: "Amount",
    method: "Method",
    card: "Bank card",
    cardDesc: "Visa, Mastercard, MIR · payment service RollyPay",
    stars: "Telegram Stars",
    starsDesc: (n: number) => `${n} ⭐ · opens the Telegram bot`,
    crypto: "Crypto (USDT)",
    cryptoDesc: (n: number) => `${n} USDT via @CryptoBot`,
    submit: (s: string) => `Donate · ${s}`,
    secure: "No subscription and no recurring charges. Card details are never stored on this site.",
    thanks: "Thank you to everyone who supports the project!",
  },
};

/** Страница пожертвования (/donate?amount=...). */
export function renderDonateBody(lang: Lang, selected: Donation): string {
  const t = D[lang];
  const method = (id: PayMethod, title: string, desc: string, checked = false) => `
        <label class="pay-method">
          <input type="radio" name="method" value="${id}"${checked ? " checked" : ""} required>
          <span><span class="pay-method-title">${esc(title)}</span><span class="pay-method-desc">${esc(desc)}</span></span>
        </label>`;
  return `
  <div class="donate">
    <div class="donate-box">
      <h1>${esc(t.title)}</h1>
      <p>${esc(t.intro)}</p>
      <p class="donate-note">${esc(t.note)}</p>
      <p style="margin-top:14px;font-weight:600;">${esc(t.thanks)}</p>
    </div>
    <form class="donate-box" method="POST" action="/donate/confirm">
      <input type="hidden" name="lang" value="${lang}">
      <input type="hidden" name="amount" value="${selected.rub}">
      <h2>${esc(t.amount)}</h2>
      <div class="donate-amounts">${DONATIONS.map((d) => `<a href="/donate?amount=${d.rub}&amp;lang=${lang}" rel="nofollow" class="${d.rub === selected.rub ? "on" : ""}">${esc(donationPrice(d, lang))}</a>`).join("")}</div>
      <h2>${esc(t.method)}</h2>
      ${method("card", t.card, t.cardDesc, true)}
      ${method("stars", t.stars, t.starsDesc(selected.stars))}
      ${method("crypto", t.crypto, t.cryptoDesc(selected.usd))}
      <button type="submit" class="pay-submit">${esc(t.submit(donationPrice(selected, lang)))}</button>
      <div class="pay-secure">${esc(t.secure)}</div>
    </form>
  </div>`;
}

/** Заглушка оплаты картой: шлюз ещё не подключён, предлагаем Telegram. */
export function renderDonateCardStubBody(lang: Lang, d: Donation, botUser: string): string {
  const isEn = lang === "en";
  return `
  <div class="pay-stub">
    <h1>${isEn ? "Card payments are being connected" : "Оплата картой и СБП подключается"}</h1>
    <p>${isEn
      ? `Thank you for wanting to support the project with <b>${esc(donationPrice(d, lang))}</b>! Card payments are not available yet.`
      : `Спасибо, что хотите поддержать проект на <b>${esc(donationPrice(d, lang))}</b>! Приём карт пока не подключён.`}</p>
    <p>${isEn ? "You can already donate via Telegram:" : "Уже сейчас можно поддержать через Telegram:"}</p>
    <div class="alt">
      <a href="${esc(botDonateLink(botUser, d, "stars"))}" target="_blank" rel="noopener">${d.stars} ⭐ Telegram Stars</a>
      <a class="sec" href="${esc(botDonateLink(botUser, d, "crypto"))}" target="_blank" rel="noopener">${d.usd} USDT</a>
    </div>
    <p style="margin-top:16px;"><a href="/donate?amount=${d.rub}&amp;lang=${lang}" style="color:#93c5fd;">&larr; ${isEn ? "Back" : "Назад"}</a></p>
  </div>`;
}

/** Возврат с формы оплаты (thanks/fail) и ошибка создания платежа (error). */
export function renderDonateResultBody(lang: Lang, d: Donation, kind: "thanks" | "fail" | "error", botUser: string): string {
  const isEn = lang === "en";
  const sum = esc(donationPrice(d, lang));
  const T = {
    thanks: isEn
      ? { h: "Thank you for your support! 💛", p: [`If the payment of <b>${sum}</b> went through, it will be credited within a few minutes. You don't need to do anything else.`, "Your donation helps pay for servers and keeps the site free for everyone."] }
      : { h: "Спасибо за поддержку! 💛", p: [`Если оплата <b>${sum}</b> прошла, она будет зачислена в течение нескольких минут. Больше ничего делать не нужно.`, "Ваше пожертвование помогает оплачивать серверы, и сайт остаётся бесплатным для всех."] },
    fail: isEn
      ? { h: "The payment did not go through", p: [`The donation of <b>${sum}</b> was not completed: it was cancelled or the payment time ran out. No money was charged.`, "You can try again or use Telegram:"] }
      : { h: "Оплата не прошла", p: [`Пожертвование <b>${sum}</b> не завершено: платёж отменён или истекло время оплаты. Деньги не списаны.`, "Можно попробовать ещё раз или поддержать через Telegram:"] },
    error: isEn
      ? { h: "Card payment is temporarily unavailable", p: [`We could not open the payment page for <b>${sum}</b>. Please try again in a few minutes.`, "You can also donate via Telegram:"] }
      : { h: "Оплата картой временно недоступна", p: [`Не получилось открыть страницу оплаты на <b>${sum}</b>. Попробуйте ещё раз через несколько минут.`, "Также можно поддержать через Telegram:"] },
  }[kind];
  const alt = kind === "thanks" ? "" : `
    <div class="alt">
      <a href="${esc(botDonateLink(botUser, d, "stars"))}" target="_blank" rel="noopener">${d.stars} ⭐ Telegram Stars</a>
      <a class="sec" href="${esc(botDonateLink(botUser, d, "crypto"))}" target="_blank" rel="noopener">${d.usd} USDT</a>
    </div>`;
  const back = kind === "thanks"
    ? `<a href="/?lang=${lang}" style="color:#93c5fd;">&larr; ${isEn ? "Back to the site" : "Вернуться на сайт"}</a>`
    : `<a href="/donate?amount=${d.rub}&amp;lang=${lang}" style="color:#93c5fd;">&larr; ${isEn ? "Try again" : "Попробовать ещё раз"}</a>`;
  return `
  <div class="pay-stub${kind === "thanks" ? " pay-ok" : ""}">
    <h1>${T.h}</h1>
    ${T.p.map((x) => `<p>${x}</p>`).join("\n    ")}${alt}
    <p style="margin-top:16px;">${back}</p>
  </div>`;
}
