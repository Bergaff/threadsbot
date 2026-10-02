/**
 * Фрагменты витрины подписки: карточки тарифов, плашка на профилях/постах, оформление заказа.
 * Чистый модуль без импорта web.ts (web.ts собирает из этих кусков полные страницы).
 *
 * Оплата картой / СБП на сайте - ЗАГЛУШКА (шлюз не подключён): кнопка ведёт на страницу
 * «способ временно недоступен» с переходом к оплате через Telegram (Stars / USDT),
 * где бот сразу выставляет счёт на выбранный тариф.
 */
import { PLANS, botBuyLink, planDuration, planPrice, planTitle, rubPerMonth, savingsPercent, type Plan, type PayMethod } from "./plans";

type Lang = "ru" | "en";

function esc(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const T = {
  ru: {
    title: "Тарифы Premium",
    subtitle: "Сайт и бот бесплатны. Premium убирает рекламу и открывает мониторинг авторов.",
    popular: "Популярный",
    best: "Выгоднее всего",
    perMonth: (n: number) => `≈ ${n} ₽ в месяц`,
    save: (n: number) => `экономия ${n}%`,
    oneTime: "разовый платёж, без автопродления",
    buy: "Купить",
    features: [
      "Сайт без рекламы",
      "Мониторинг до 5 авторов: новые посты приходят в Telegram",
      "Без лимитов запросов в Telegram-боте",
      "Комментарии и медиа без ограничений",
    ],
    free: "Бесплатно: просмотр сайта без регистрации, 5 запросов в день в боте",
    methods: "Банковская карта / СБП · Telegram Stars · USDT",
    allPlans: "Все тарифы и условия",
    promo: "Premium: без рекламы и с уведомлениями о новых постах в Telegram",
    promoFrom: "от 39 ₽",
    promoBtn: "Тарифы",
  },
  en: {
    title: "Premium plans",
    subtitle: "The site and the bot are free. Premium removes ads and unlocks creator tracking.",
    popular: "Popular",
    best: "Best value",
    perMonth: (n: number) => `≈ ${n} ₽ / month`,
    save: (n: number) => `save ${n}%`,
    oneTime: "one-time payment, no auto-renewal",
    buy: "Buy",
    features: [
      "Ad-free website",
      "Track up to 5 creators: new posts delivered to Telegram",
      "Unlimited requests in the Telegram bot",
      "Unlimited comments and media",
    ],
    free: "Free: browse the site without sign-up, 5 bot requests per day",
    methods: "Bank card · Telegram Stars · USDT",
    allPlans: "All plans and terms",
    promo: "Premium: no ads plus new-post alerts in Telegram",
    promoFrom: "from $0.49",
    promoBtn: "Plans",
  },
};

export const PRICING_CSS = `
  .pricing-card { max-width: 920px; margin: 24px auto 0; padding: 22px 22px 18px; background: #141414; border: 1px solid #282828; text-align: left; }
  .pricing-head h2 { font-size: 1.2rem; font-weight: 700; color: #fff; margin: 0 0 6px; }
  .pricing-head p { color: #9ca3af; font-size: 0.88rem; margin: 0 0 16px; }
  .pricing-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
  .plan { position: relative; display: flex; flex-direction: column; background: #181818; border: 1px solid #2a2a2a; padding: 16px 14px 14px; }
  .plan.plan-popular { border-color: #3b82f6; }
  .plan.plan-best { border-color: #22c55e; }
  .plan-badge { position: absolute; top: -10px; left: 12px; font-size: 0.68rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px; padding: 2px 8px; background: #3b82f6; color: #fff; }
  .plan-best .plan-badge { background: #16a34a; }
  .plan-name { font-size: 0.95rem; font-weight: 700; color: #fff; }
  .plan-days { font-size: 0.78rem; color: #8b8b8b; margin-top: 2px; }
  .plan-price { font-size: 1.7rem; font-weight: 800; color: #fff; margin: 10px 0 2px; letter-spacing: -0.5px; }
  .plan-sub { font-size: 0.76rem; color: #9ca3af; min-height: 2.3em; }
  .plan-save { color: #4ade80; font-weight: 600; }
  .plan-buy { display: block; margin-top: 12px; text-align: center; padding: 9px 10px; background: #2563eb; color: #fff !important; font-weight: 700; font-size: 0.9rem; text-decoration: none; border: 0; }
  .plan-buy:hover { background: #1d4ed8; }
  .plan:not(.plan-popular):not(.plan-best) .plan-buy { background: #262626; border: 1px solid #3a3a3a; }
  .plan:not(.plan-popular):not(.plan-best) .plan-buy:hover { background: #303030; }
  .pricing-features { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 6px 18px; margin: 16px 0 0; padding: 0; list-style: none; font-size: 0.85rem; color: #d1d5db; }
  .pricing-features li::before { content: "✓"; color: #4ade80; font-weight: 700; margin-right: 8px; }
  .pricing-foot { display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-top: 14px; padding-top: 12px; border-top: 1px solid #242424; font-size: 0.78rem; color: #8b8b8b; }
  .pricing-foot a { color: #60a5fa; }
  .premium-promo { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 14px 0; padding: 10px 14px; background: #111827; border: 1px solid #1e3a8a; font-size: 0.86rem; color: #dbeafe; }
  .premium-promo b { color: #fff; }
  .premium-promo a { white-space: nowrap; padding: 6px 12px; background: #2563eb; color: #fff !important; font-weight: 700; text-decoration: none; font-size: 0.82rem; }
  .checkout { max-width: 760px; margin: 28px auto; display: grid; grid-template-columns: 1fr 1.25fr; gap: 16px; text-align: left; }
  .checkout-box { background: #141414; border: 1px solid #282828; padding: 20px; }
  .checkout-box h1, .checkout-box h2 { font-size: 1.1rem; color: #fff; margin: 0 0 12px; }
  .checkout-row { display: flex; justify-content: space-between; gap: 8px; padding: 7px 0; border-bottom: 1px solid #222; font-size: 0.9rem; color: #d1d5db; }
  .checkout-row b { color: #fff; }
  .checkout-total { font-size: 1.25rem; font-weight: 800; color: #fff; }
  .checkout-plans { display: flex; gap: 6px; flex-wrap: wrap; margin: 4px 0 12px; }
  .checkout-plans a { padding: 5px 10px; border: 1px solid #333; color: #cbd5e1; font-size: 0.8rem; text-decoration: none; }
  .checkout-plans a.on { border-color: #3b82f6; color: #fff; background: #172554; }
  .pay-method { display: flex; gap: 10px; align-items: flex-start; padding: 11px 12px; border: 1px solid #2a2a2a; background: #181818; margin-bottom: 8px; cursor: pointer; }
  .pay-method:has(input:checked) { border-color: #3b82f6; background: #111a2e; }
  .pay-method input { margin-top: 3px; accent-color: #3b82f6; }
  .pay-method-title { font-weight: 700; color: #fff; font-size: 0.9rem; }
  .pay-method-desc { font-size: 0.78rem; color: #9ca3af; margin-top: 2px; }
  .pay-agree { display: flex; gap: 8px; align-items: flex-start; font-size: 0.8rem; color: #9ca3af; margin: 12px 0; }
  .pay-agree a { color: #60a5fa; }
  .pay-submit { width: 100%; padding: 12px; background: #2563eb; color: #fff; border: 0; font-weight: 800; font-size: 1rem; cursor: pointer; }
  .pay-submit:hover { background: #1d4ed8; }
  .pay-secure { font-size: 0.74rem; color: #6b7280; margin-top: 10px; text-align: center; }
  .pay-stub { max-width: 560px; margin: 36px auto; background: #141414; border: 1px solid #f59e0b; padding: 24px; text-align: left; }
  .pay-stub h1 { font-size: 1.15rem; color: #fff; margin: 0 0 10px; }
  .pay-stub p { color: #cbd5e1; font-size: 0.9rem; line-height: 1.5; margin: 8px 0; }
  .pay-stub .alt { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 14px; }
  .pay-stub .alt a { flex: 1; min-width: 200px; text-align: center; padding: 10px; background: #2563eb; color: #fff !important; font-weight: 700; text-decoration: none; }
  .pay-stub .alt a.sec { background: #262626; border: 1px solid #3a3a3a; }
  @media (max-width: 820px) { .pricing-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .checkout { grid-template-columns: 1fr; } }
  @media (max-width: 480px) { .pricing-features { grid-template-columns: 1fr; } .plan-price { font-size: 1.45rem; } }
  html[data-theme="light"] .pricing-card, html[data-theme="light"] .checkout-box { background: #e6ded0; border-color: #b5ab99; }
  html[data-theme="light"] .pay-stub { background: #e6ded0; border-color: #b7791f; }
  html[data-theme="light"] .pricing-head h2, html[data-theme="light"] .plan-name, html[data-theme="light"] .plan-price,
  html[data-theme="light"] .checkout-box h1, html[data-theme="light"] .checkout-box h2, html[data-theme="light"] .checkout-row b,
  html[data-theme="light"] .checkout-total, html[data-theme="light"] .pay-method-title, html[data-theme="light"] .pay-stub h1 { color: #1e1913; }
  html[data-theme="light"] .pricing-head p, html[data-theme="light"] .plan-days, html[data-theme="light"] .plan-sub,
  html[data-theme="light"] .pay-method-desc, html[data-theme="light"] .pay-agree, html[data-theme="light"] .pricing-foot { color: #5c5346; }
  html[data-theme="light"] .plan, html[data-theme="light"] .pay-method { background: #ded5c6; border-color: #b8ad9b; }
  html[data-theme="light"] .plan.plan-popular, html[data-theme="light"] .pay-method:has(input:checked) { border-color: #1a56a6; background: #d9d3cc; }
  html[data-theme="light"] .plan.plan-best { border-color: #15803d; }
  html[data-theme="light"] .plan-save { color: #15803d; }
  html[data-theme="light"] .pricing-features li::before { color: #15803d; }
  html[data-theme="light"] .pricing-features, html[data-theme="light"] .checkout-row, html[data-theme="light"] .pay-stub p { color: #2e2820; }
  html[data-theme="light"] .checkout-row, html[data-theme="light"] .pricing-foot { border-color: #c9bfae; }
  html[data-theme="light"] .plan:not(.plan-popular):not(.plan-best) .plan-buy, html[data-theme="light"] .pay-stub .alt a.sec { background: #24201a; border-color: #24201a; color: #f7f4ee !important; }
  html[data-theme="light"] .pricing-foot a, html[data-theme="light"] .pay-agree a { color: #1a56a6; }
  html[data-theme="light"] .premium-promo { background: #dbd3c5; border-color: #b5ab99; color: #2e2820; }
  html[data-theme="light"] .premium-promo b { color: #1e1913; }
  html[data-theme="light"] .checkout-plans a { border-color: #b8ad9b; color: #2e2820; }
  html[data-theme="light"] .checkout-plans a.on { background: #d9d3cc; color: #1e1913; border-color: #1a56a6; }
`;

function planCard(p: Plan, lang: Lang): string {
  const t = T[lang];
  const save = savingsPercent(p, lang === "en" ? "usd" : "rub");
  const sub = p.days >= 90
    ? `${lang === "en" ? `$${(p.usd / (p.days / 30)).toFixed(2)} / month` : t.perMonth(rubPerMonth(p))}${save ? ` · <span class="plan-save">${t.save(save)}</span>` : ""}`
    : esc(t.oneTime);
  const badge = p.badge === "popular" ? t.popular : p.badge === "best" ? t.best : "";
  return `
      <div class="plan${p.badge ? ` plan-${p.badge}` : ""}" data-plan="${p.id}">
        ${badge ? `<span class="plan-badge">${esc(badge)}</span>` : ""}
        <div class="plan-name">${esc(planTitle(p, lang))}</div>
        <div class="plan-days">${esc(planDuration(p, lang))}</div>
        <div class="plan-price">${esc(planPrice(p, lang))}</div>
        <div class="plan-sub">${sub}</div>
        <a class="plan-buy" href="/pay?plan=${p.id}&amp;lang=${lang}" rel="nofollow">${esc(t.buy)}</a>
      </div>`;
}

/** Блок тарифов (главная и /pricing). */
export function renderPricingSection(lang: Lang, opts: { heading?: "h1" | "h2"; showAllLink?: boolean } = {}): string {
  const t = T[lang];
  const h = opts.heading || "h2";
  return `
    <section class="pricing-card" id="pricing">
      <div class="pricing-head">
        <${h}>${esc(t.title)}</${h}>
        <p>${esc(t.subtitle)}</p>
      </div>
      <div class="pricing-grid">${PLANS.map((p) => planCard(p, lang)).join("")}
      </div>
      <ul class="pricing-features">${t.features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      <div class="pricing-foot">
        <span>${esc(t.free)}</span>
        <span>${esc(t.methods)}${opts.showAllLink ? ` · <a href="/pricing?lang=${lang}">${esc(t.allPlans)}</a>` : ""}</span>
      </div>
    </section>`;
}

/** Компактная плашка для страниц профиля и поста. */
export function renderPremiumPromo(lang: Lang): string {
  const t = T[lang];
  return `
    <div class="premium-promo">
      <span>${esc(t.promo)} <b>${esc(t.promoFrom)}</b></span>
      <a href="/pricing?lang=${lang}" rel="nofollow">${esc(t.promoBtn)}</a>
    </div>`;
}

const CHECKOUT = {
  ru: {
    title: "Оформление подписки",
    order: "Ваш заказ",
    plan: "Тариф",
    period: "Срок",
    total: "К оплате",
    change: "Другой тариф:",
    method: "Способ оплаты",
    card: "Банковская карта / СБП",
    cardDesc: "МИР, Visa, Mastercard, Система быстрых платежей",
    stars: "Telegram Stars",
    starsDesc: (n: number) => `${n} ⭐ · счёт придёт в Telegram-бот, активация мгновенно`,
    crypto: "Криптовалюта (USDT)",
    cryptoDesc: (n: number) => `${n} USDT через @CryptoBot · активация после оплаты`,
    agree: "Я принимаю",
    terms: "условия оферты и возврата",
    pay: (s: string) => `Перейти к оплате · ${s}`,
    secure: "Подписка не продлевается автоматически. Данные карт сайт не хранит.",
    includes: "Что входит",
    after: "После оплаты бот пришлёт персональную ссылку: по ней сайт откроется без рекламы.",
  },
  en: {
    title: "Checkout",
    order: "Your order",
    plan: "Plan",
    period: "Period",
    total: "Total",
    change: "Other plans:",
    method: "Payment method",
    card: "Bank card",
    cardDesc: "Visa, Mastercard, MIR",
    stars: "Telegram Stars",
    starsDesc: (n: number) => `${n} ⭐ · invoice arrives in the Telegram bot, instant activation`,
    crypto: "Crypto (USDT)",
    cryptoDesc: (n: number) => `${n} USDT via @CryptoBot · activated after payment`,
    agree: "I accept the",
    terms: "terms of service and refund policy",
    pay: (s: string) => `Proceed to payment · ${s}`,
    secure: "No auto-renewal. Card details are never stored on this site.",
    includes: "What you get",
    after: "After payment the bot sends a personal link that opens the site without ads.",
  },
};

/** Страница оформления заказа (/pay?plan=...). */
export function renderCheckoutBody(lang: Lang, plan: Plan): string {
  const t = CHECKOUT[lang];
  const price = planPrice(plan, lang);
  const method = (id: PayMethod, title: string, desc: string, checked = false) => `
        <label class="pay-method">
          <input type="radio" name="method" value="${id}"${checked ? " checked" : ""} required>
          <span><span class="pay-method-title">${esc(title)}</span><span class="pay-method-desc" style="display:block;">${esc(desc)}</span></span>
        </label>`;
  return `
  <div class="checkout">
    <div class="checkout-box">
      <h2>${esc(t.order)}</h2>
      <div class="checkout-row"><span>${esc(t.plan)}</span><b>Premium · ${esc(planTitle(plan, lang))}</b></div>
      <div class="checkout-row"><span>${esc(t.period)}</span><b>${esc(planDuration(plan, lang))}</b></div>
      <div class="checkout-row" style="border-bottom:0;"><span>${esc(t.total)}</span><span class="checkout-total">${esc(price)}</span></div>
      <div style="font-size:0.78rem;color:#8b8b8b;margin:8px 0 4px;">${esc(t.change)}</div>
      <div class="checkout-plans">${PLANS.map((p) => `<a href="/pay?plan=${p.id}&amp;lang=${lang}" rel="nofollow" class="${p.id === plan.id ? "on" : ""}">${esc(planTitle(p, lang))} · ${esc(planPrice(p, lang))}</a>`).join("")}</div>
      <h2 style="margin-top:14px;font-size:0.95rem;">${esc(t.includes)}</h2>
      <ul class="pricing-features" style="grid-template-columns:1fr;margin-top:0;">${T[lang].features.map((f) => `<li>${esc(f)}</li>`).join("")}</ul>
      <p style="font-size:0.78rem;color:#8b8b8b;margin:12px 0 0;">${esc(t.after)}</p>
    </div>
    <form class="checkout-box" method="GET" action="/pay/confirm">
      <h1>${esc(t.title)}</h1>
      <input type="hidden" name="plan" value="${plan.id}">
      <input type="hidden" name="lang" value="${lang}">
      <div style="font-size:0.85rem;color:#9ca3af;margin-bottom:8px;">${esc(t.method)}</div>
      ${method("card", t.card, t.cardDesc, true)}
      ${method("stars", t.stars, t.starsDesc(plan.stars))}
      ${method("crypto", t.crypto, t.cryptoDesc(plan.usd))}
      <label class="pay-agree"><input type="checkbox" name="agree" value="1" required> <span>${esc(t.agree)} <a href="/terms?lang=${lang}" target="_blank" rel="noopener">${esc(t.terms)}</a></span></label>
      <button type="submit" class="pay-submit">${esc(t.pay(price))}</button>
      <div class="pay-secure">${esc(t.secure)}</div>
    </form>
  </div>`;
}

/** Заглушка оплаты картой: шлюз ещё не подключён, предлагаем Telegram. */
export function renderCardStubBody(lang: Lang, plan: Plan, botUser: string): string {
  const isEn = lang === "en";
  return `
  <div class="pay-stub">
    <h1>${isEn ? "Card payments are being connected" : "Оплата картой и СБП подключается"}</h1>
    <p>${isEn
      ? `We are connecting a card payment provider. Your order: <b>Premium · ${esc(planTitle(plan, lang))}</b> (${esc(planDuration(plan, lang))}) for <b>${esc(planPrice(plan, lang))}</b>.`
      : `Мы подключаем платёжный шлюз для банковских карт. Ваш заказ: <b>Premium · ${esc(planTitle(plan, lang))}</b> (${esc(planDuration(plan, lang))}) за <b>${esc(planPrice(plan, lang))}</b>.`}</p>
    <p>${isEn
      ? "You can pay right now in Telegram: the bot will issue an invoice for this exact plan and activate it instantly."
      : "Оплатить этот тариф можно уже сейчас в Telegram: бот сразу выставит счёт на выбранный тариф и активирует подписку."}</p>
    <div class="alt">
      <a href="${esc(botBuyLink(botUser, plan, "stars"))}" target="_blank" rel="noopener">${isEn ? `Pay ${plan.stars} ⭐ Stars` : `Оплатить ${plan.stars} ⭐ Stars`}</a>
      <a class="sec" href="${esc(botBuyLink(botUser, plan, "crypto"))}" target="_blank" rel="noopener">${isEn ? `Pay ${plan.usd} USDT` : `Оплатить ${plan.usd} USDT`}</a>
    </div>
    <p style="margin-top:16px;"><a href="/pay?plan=${plan.id}&amp;lang=${lang}" style="color:#93c5fd;">&larr; ${isEn ? "Back to checkout" : "Вернуться к заказу"}</a></p>
  </div>`;
}
