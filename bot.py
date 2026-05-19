import os
import json
import asyncio
import sqlite3
import random
import re
import aiohttp
import logging
import time
from datetime import datetime, timedelta
from pathlib import Path
from playwright.async_api import async_playwright
from aiogram import Bot, Dispatcher, F
from aiogram.filters import Command, BaseFilter
from aiogram.client.default import DefaultBotProperties
from aiogram.client.session.aiohttp import AiohttpSession
from aiogram.types import (
    Message, CallbackQuery,
    InlineKeyboardMarkup, InlineKeyboardButton,
    BufferedInputFile, LabeledPrice,
    PreCheckoutQuery,
)

# Загрузка .env (если есть)
try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

logging.basicConfig(level=logging.WARNING)

# ============================
# НАСТРОЙКИ (через переменные окружения)
# ============================
TELEGRAM_TOKEN = os.getenv("TELEGRAM_TOKEN", "")
CRYPTO_BOT_TOKEN = os.getenv("CRYPTO_BOT_TOKEN", "")
ADMIN_IDS = [int(x) for x in os.getenv("ADMIN_IDS", "369330135,657708753").split(",")]

if not TELEGRAM_TOKEN:
    raise RuntimeError("❌ TELEGRAM_TOKEN не задан! Создай .env или экспортируй переменную.")
if not CRYPTO_BOT_TOKEN:
    raise RuntimeError("❌ CRYPTO_BOT_TOKEN не задан!")

ACCOUNTS_DIR = Path("accounts")
STATS_FILE = Path("data/stats.json")
DB_FILE = Path("data/bot.db")

# Базовый домен Threads — все cookies должны быть на одном домене!
BASE_URL = "https://www.threads.com"

PRICE_STARS = 150
PRICE_CRYPTO_USD = 2.5

SUBSCRIPTION_DAYS = 30
FREE_MONTHLY_LIMIT = 10
FREE_DAILY_LIMIT = 3

RATE_PER_MINUTE = 3
RATE_PER_HOUR = 15
RATE_PER_DAY = 50
CACHE_TTL_MINUTES = 5
ACCOUNT_HOURLY_LIMIT = 20

last_alert_time = 0
ALERT_COOLDOWN = 3600

STRIP_WORDS = [
    "Translate", "Перевести", "See translation",
    "See more", "Показать перевод"]


# ============================
# ЛОКАЛИЗАЦИЯ (RU / EN / DE / ES / PT)
# ============================
TRANSLATIONS = {
    'ru': {
        'welcome': "👋 <b>Добро пожаловать в Threads Reader Bot!</b>\n\n"
                   "Я помогаю читать посты и комментарии из Threads.\n\n"
                   "📌 <b>Как пользоваться:</b>\n"
                   "1. Напиши username\n"
                   "2. Выбери формат — текст или скриншоты\n"
                   "3. Ответь на пост, чтобы загрузить комментарии\n\n"
                   "Пример: <code>zuck</code>\n\n"
                   "{status}\n\n"
                   "Используй /help, чтобы посмотреть доступные команды.",
        'help': "ℹ️ <b>Как пользоваться:</b>\n\n"
                "1. Напиши username\n2. Выбери формат\n"
                "3. Листай кнопкой «Ещё»\n"
                "4. Ответь на пост — комментарии\n\n"
                "/subscribe — подписка\n/status — статус\n"
                "/support — поддержка",
        'select_language': "🌍 Выберите язык:",
        'language_set': "✅ Язык установлен: Русский",
        'subscription_active': "✅ Подписка активна ({days} дн.)",
        'free_limit': "🆓 Бесплатно: {daily} на сегодня, {monthly} в этом месяце",
        'no_subscription': "❌ Нет активной подписки",
        'daily_limit_reached': "⏳ Дневной лимит ({limit}/{limit}) исчерпан.\nНовые попытки появятся завтра!",
        'monthly_limit_reached': "🛑 Месячный лимит бесплатных запросов исчерпан.",
        'posts_found': "📱 <b>@{username}</b> ({count} постов)",
        'invalid_username': "❌ Это не username.",
        'rate_limit': "⏳ {reason}",
        'no_accounts': "❌ Нет рабочих аккаунтов",
        'admins_notified': "Админы оповещены.",
        'all_dead': "❌ Все аккаунты недоступны.",
        'user_not_found': "❌ @{username} не найден.",
        'no_posts': "😔 Нет постов.",
        'no_more': "📭 Больше нет.",
        'photo': "фото",
        'video': "видео",
        'subscribe_btn': "💳 Оформить подписку",
        'subscribe_unlocks': "🔓 Подписка даёт полный безлимит:",
        'text_btn': "📝 Текст",
        'screens_btn': "🖼 Скрины",
        'format': "формат",
        'more': "Ещё",
        'of': "из",
        'all': "Все",
        'more_available': "➡️ Есть ещё!",
        'reply_for_comments': "💬 Ответь на пост — комментарии",
        'send_other': "Нужен другой username? Пиши👇",
        'paid': "Оплачено",
        'until': "До",
        'not_found': "Не найдена",
        'pay': "Оплатить",
        'i_paid': "Я оплатил",
        'after_payment': "После оплаты нажми",
        'subscription': "Подписка",
        'days': "дней",
        'unlimited': "Безлимит",
        'left_today': "Осталось сегодня",
        'renew': "Продлить",
        'subscribe': "Оформить",
        'active': "Активна",
        'no_sub_short': "Нет подписки",
        'support_title': "🆘 Поддержка",
        'ask_question': "Задай вопрос",
        'suggest_idea': "Предложи идею",
        'choose': "Выбери",
        'question': "Вопрос",
        'suggestion': "Предложение",
        'my_tickets': "Мои обращения",
        'payment_method': "💳 Способ оплаты:",
    },
    'en': {
        'welcome': "👋 <b>Welcome to Threads Reader Bot!</b>\n\n"
                   "I help you read posts and comments from Threads.\n\n"
                   "📌 <b>How to use:</b>\n"
                   "1. Send username\n"
                   "2. Choose format — text or screenshots\n"
                   "3. Reply to a post to load comments\n\n"
                   "Example: <code>zuck</code>\n\n"
                   "{status}\n\n"
                   "Use /help to see available commands.",
        'help': "ℹ️ <b>How to use:</b>\n\n"
                "1. Send username\n2. Choose format\n"
                "3. Use «More» button\n"
                "4. Reply to a post for comments\n\n"
                "/subscribe — subscription\n/status — status\n"
                "/support — support",
        'select_language': "🌍 Select language:",
        'language_set': "✅ Language set: English",
        'subscription_active': "✅ Subscription active ({days} days)",
        'free_limit': "🆓 Free: {daily} today, {monthly} this month",
        'no_subscription': "❌ No active subscription",
        'daily_limit_reached': "⏳ Daily limit ({limit}/{limit}) reached.\nNew attempts tomorrow!",
        'monthly_limit_reached': "🛑 Monthly free limit reached.",
        'posts_found': "📱 <b>@{username}</b> ({count} posts)",
        'invalid_username': "❌ Invalid username.",
        'rate_limit': "⏳ {reason}",
        'no_accounts': "❌ No working accounts",
        'admins_notified': "Admins notified.",
        'all_dead': "❌ All accounts unavailable.",
        'user_not_found': "❌ @{username} not found.",
        'no_posts': "😔 No posts.",
        'no_more': "📭 No more.",
        'photo': "photo",
        'video': "video",
        'subscribe_btn': "💳 Subscribe",
        'subscribe_unlocks': "🔓 Subscription unlocks unlimited access:",
        'text_btn': "📝 Text",
        'screens_btn': "🖼 Screens",
        'format': "format",
        'more': "More",
        'of': "of",
        'all': "All",
        'more_available': "➡️ More available!",
        'reply_for_comments': "💬 Reply to post for comments",
        'send_other': "Need another username? Type it👇",
        'paid': "Paid",
        'until': "Until",
        'not_found': "Not found",
        'pay': "Pay",
        'i_paid': "I paid",
        'after_payment': "After payment click",
        'subscription': "Subscription",
        'days': "days",
        'unlimited': "Unlimited",
        'left_today': "Left today",
        'renew': "Renew",
        'subscribe': "Subscribe",
        'active': "Active",
        'no_sub_short': "No subscription",
        'support_title': "🆘 Support",
        'ask_question': "Ask a question",
        'suggest_idea': "Suggest an idea",
        'choose': "Select",
        'question': "Question",
        'suggestion': "Suggestion",
        'my_tickets': "My tickets",
        'payment_method': "💳 Payment method:",
    },
    'de': {
        'welcome': "👋 <b>Willkommen beim Threads Reader Bot!</b>\n\n"
                   "Ich helfe dir, Beiträge und Kommentare aus Threads zu lesen.\n\n"
                   "📌 <b>Wie benutzen:</b>\n"
                   "1. Sende einen Benutzernamen\n"
                   "2. Wähle Format — Text oder Screenshots\n"
                   "3. Antworte auf einen Beitrag, um Kommentare zu laden\n\n"
                   "Beispiel: <code>zuck</code>\n\n"
                   "{status}\n\n"
                   "Verwende /help, um verfügbare Befehle zu sehen.",
        'help': "ℹ️ <b>Wie benutzen:</b>\n\n"
                "1. Sende einen Benutzernamen\n2. Wähle Format\n"
                "3. Verwende «Mehr»\n"
                "4. Antworte auf einen Beitrag — Kommentare\n\n"
                "/subscribe — Abo\n/status — Status\n"
                "/support — Support",
        'select_language': "🌍 Sprache wählen:",
        'language_set': "✅ Sprache: Deutsch",
        'subscription_active': "✅ Abo aktiv ({days} Tage)",
        'free_limit': "🆓 Kostenlos: {daily} heute, {monthly} diesen Monat",
        'no_subscription': "❌ Kein aktives Abo",
        'daily_limit_reached': "⏳ Tageslimit ({limit}/{limit}) erreicht.\nMorgen neue Versuche!",
        'monthly_limit_reached': "🛑 Monatliches Gratislimit erreicht.",
        'posts_found': "📱 <b>@{username}</b> ({count} Beiträge)",
        'invalid_username': "❌ Ungültiger Benutzername.",
        'rate_limit': "⏳ {reason}",
        'no_accounts': "❌ Keine funktionierenden Konten",
        'admins_notified': "Admins benachrichtigt.",
        'all_dead': "❌ Alle Konten nicht verfügbar.",
        'user_not_found': "❌ @{username} nicht gefunden.",
        'no_posts': "😔 Keine Beiträge.",
        'no_more': "📭 Keine weiteren.",
        'photo': "Foto",
        'video': "Video",
        'subscribe_btn': "💳 Abonnieren",
        'subscribe_unlocks': "🔓 Abo gibt unbegrenzten Zugang:",
        'text_btn': "📝 Text",
        'screens_btn': "🖼 Screenshots",
        'format': "Format",
        'more': "Mehr",
        'of': "von",
        'all': "Alle",
        'more_available': "➡️ Mehr verfügbar!",
        'reply_for_comments': "💬 Antworte auf den Beitrag für Kommentare",
        'send_other': "Anderen Benutzernamen? Schreib👇",
        'paid': "Bezahlt",
        'until': "Bis",
        'not_found': "Nicht gefunden",
        'pay': "Bezahlen",
        'i_paid': "Ich habe bezahlt",
        'after_payment': "Nach Zahlung klicken",
        'subscription': "Abo",
        'days': "Tage",
        'unlimited': "Unbegrenzt",
        'left_today': "Heute übrig",
        'renew': "Verlängern",
        'subscribe': "Abonnieren",
        'active': "Aktiv",
        'no_sub_short': "Kein Abo",
        'support_title': "🆘 Support",
        'ask_question': "Stelle eine Frage",
        'suggest_idea': "Schlage eine Idee vor",
        'choose': "Wähle",
        'question': "Frage",
        'suggestion': "Vorschlag",
        'my_tickets': "Meine Tickets",
        'payment_method': "💳 Zahlungsmethode:",
    },
    'es': {
        'welcome': "👋 <b>¡Bienvenido a Threads Reader Bot!</b>\n\n"
                   "Te ayudo a leer publicaciones y comentarios de Threads.\n\n"
                   "📌 <b>Cómo usar:</b>\n"
                   "1. Envía un username\n"
                   "2. Elige formato — texto o capturas\n"
                   "3. Responde a un post para cargar comentarios\n\n"
                   "Ejemplo: <code>zuck</code>\n\n"
                   "{status}\n\n"
                   "Usa /help para ver comandos disponibles.",
        'help': "ℹ️ <b>Cómo usar:</b>\n\n"
                "1. Envía un username\n2. Elige formato\n"
                "3. Usa el botón «Más»\n"
                "4. Responde a un post — comentarios\n\n"
                "/subscribe — suscripción\n/status — estado\n"
                "/support — soporte",
        'select_language': "🌍 Selecciona idioma:",
        'language_set': "✅ Idioma: Español",
        'subscription_active': "✅ Suscripción activa ({days} días)",
        'free_limit': "🆓 Gratis: {daily} hoy, {monthly} este mes",
        'no_subscription': "❌ Sin suscripción activa",
        'daily_limit_reached': "⏳ Límite diario ({limit}/{limit}) alcanzado.\n¡Nuevos intentos mañana!",
        'monthly_limit_reached': "🛑 Límite gratuito mensual alcanzado.",
        'posts_found': "📱 <b>@{username}</b> ({count} posts)",
        'invalid_username': "❌ Username inválido.",
        'rate_limit': "⏳ {reason}",
        'no_accounts': "❌ Sin cuentas funcionales",
        'admins_notified': "Admins notificados.",
        'all_dead': "❌ Todas las cuentas no disponibles.",
        'user_not_found': "❌ @{username} no encontrado.",
        'no_posts': "😔 Sin publicaciones.",
        'no_more': "📭 No hay más.",
        'photo': "foto",
        'video': "vídeo",
        'subscribe_btn': "💳 Suscribirse",
        'subscribe_unlocks': "🔓 La suscripción da acceso ilimitado:",
        'text_btn': "📝 Texto",
        'screens_btn': "🖼 Capturas",
        'format': "formato",
        'more': "Más",
        'of': "de",
        'all': "Todo",
        'more_available': "➡️ ¡Hay más!",
        'reply_for_comments': "💬 Responde al post para comentarios",
        'send_other': "¿Otro username? Escríbelo👇",
        'paid': "Pagado",
        'until': "Hasta",
        'not_found': "No encontrado",
        'pay': "Pagar",
        'i_paid': "He pagado",
        'after_payment': "Después del pago haz clic",
        'subscription': "Suscripción",
        'days': "días",
        'unlimited': "Ilimitado",
        'left_today': "Restante hoy",
        'renew': "Renovar",
        'subscribe': "Suscribirse",
        'active': "Activa",
        'no_sub_short': "Sin suscripción",
        'support_title': "🆘 Soporte",
        'ask_question': "Haz una pregunta",
        'suggest_idea': "Sugiere una idea",
        'choose': "Elige",
        'question': "Pregunta",
        'suggestion': "Sugerencia",
        'my_tickets': "Mis tickets",
        'payment_method': "💳 Método de pago:",
    },
    'pt': {
        'welcome': "👋 <b>Bem-vindo ao Threads Reader Bot!</b>\n\n"
                   "Ajudo você a ler posts e comentários do Threads.\n\n"
                   "📌 <b>Como usar:</b>\n"
                   "1. Envie um username\n"
                   "2. Escolha formato — texto ou screenshots\n"
                   "3. Responda a um post para carregar comentários\n\n"
                   "Exemplo: <code>zuck</code>\n\n"
                   "{status}\n\n"
                   "Use /help para ver os comandos disponíveis.",
        'help': "ℹ️ <b>Como usar:</b>\n\n"
                "1. Envie um username\n2. Escolha formato\n"
                "3. Use o botão «Mais»\n"
                "4. Responda a um post — comentários\n\n"
                "/subscribe — assinatura\n/status — status\n"
                "/support — suporte",
        'select_language': "🌍 Selecione o idioma:",
        'language_set': "✅ Idioma: Português",
        'subscription_active': "✅ Assinatura ativa ({days} dias)",
        'free_limit': "🆓 Grátis: {daily} hoje, {monthly} este mês",
        'no_subscription': "❌ Sem assinatura ativa",
        'daily_limit_reached': "⏳ Limite diário ({limit}/{limit}) atingido.\nNovas tentativas amanhã!",
        'monthly_limit_reached': "🛑 Limite mensal gratuito atingido.",
        'posts_found': "📱 <b>@{username}</b> ({count} posts)",
        'invalid_username': "❌ Username inválido.",
        'rate_limit': "⏳ {reason}",
        'no_accounts': "❌ Sem contas funcionais",
        'admins_notified': "Admins notificados.",
        'all_dead': "❌ Todas as contas indisponíveis.",
        'user_not_found': "❌ @{username} não encontrado.",
        'no_posts': "😔 Sem posts.",
        'no_more': "📭 Não há mais.",
        'photo': "foto",
        'video': "vídeo",
        'subscribe_btn': "💳 Assinar",
        'subscribe_unlocks': "🔓 A assinatura dá acesso ilimitado:",
        'text_btn': "📝 Texto",
        'screens_btn': "🖼 Screenshots",
        'format': "formato",
        'more': "Mais",
        'of': "de",
        'all': "Tudo",
        'more_available': "➡️ Há mais!",
        'reply_for_comments': "💬 Responda ao post para comentários",
        'send_other': "Outro username? Escreva👇",
        'paid': "Pago",
        'until': "Até",
        'not_found': "Não encontrado",
        'pay': "Pagar",
        'i_paid': "Eu paguei",
        'after_payment': "Após o pagamento, clique",
        'subscription': "Assinatura",
        'days': "dias",
        'unlimited': "Ilimitado",
        'left_today': "Restante hoje",
        'renew': "Renovar",
        'subscribe': "Assinar",
        'active': "Ativa",
        'no_sub_short': "Sem assinatura",
        'support_title': "🆘 Suporte",
        'ask_question': "Faça uma pergunta",
        'suggest_idea': "Sugira uma ideia",
        'choose': "Selecione",
        'question': "Pergunta",
        'suggestion': "Sugestão",
        'my_tickets': "Meus tickets",
        'payment_method': "💳 Método de pagamento:",
    }
}

LANGUAGE_NAMES = {
    'ru': '🇷🇺 Русский',
    'en': '🇬🇧 English',
    'de': '🇩🇪 Deutsch',
    'es': '🇪🇸 Español',
    'pt': '🇵🇹 Português',
}


def get_text(key, lang='ru', **kwargs):
    """Получить текст. Если ключа нет в выбранном языке — fallback на английский, потом на ключ."""
    text = TRANSLATIONS.get(lang, {}).get(key)
    if text is None:
        text = TRANSLATIONS.get('en', {}).get(key, key)
    try:
        return text.format(**kwargs)
    except (KeyError, IndexError):
        return text


def clean_post_text(text):
    t = text.strip()
    for word in STRIP_WORDS:
        if t.endswith(word):
            t = t[:-len(word)].strip()
        if t.endswith("\n" + word):
            t = t[:-(len(word) + 1)].strip()
        if t.endswith("  " + word):
            t = t[:-(len(word) + 2)].strip()
    return t


# ============================
# БАЗА ДАННЫХ
# ============================

class Database:
    def __init__(self, db_path):
        self.db_path = db_path
        db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row
        self._create_tables()

    def _create_tables(self):
        self.conn.executescript("""
            CREATE TABLE IF NOT EXISTS banned_users (
                user_id INTEGER PRIMARY KEY, username TEXT,
                reason TEXT, banned_at TEXT);
            CREATE TABLE IF NOT EXISTS request_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER, username_requested TEXT,
                timestamp TEXT);
            CREATE TABLE IF NOT EXISTS cache (
                username TEXT, mode TEXT, page INTEGER,
                data TEXT, cached_at TEXT,
                PRIMARY KEY (username, mode, page));
            CREATE TABLE IF NOT EXISTS subscriptions (
                user_id INTEGER PRIMARY KEY, expires_at TEXT,
                payment_method TEXT, total_paid REAL DEFAULT 0,
                payments_count INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS free_usage (
                user_id INTEGER PRIMARY KEY,
                requests_used INTEGER DEFAULT 0);
            CREATE TABLE IF NOT EXISTS payments_log (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER, amount TEXT,
                method TEXT, timestamp TEXT);
            CREATE TABLE IF NOT EXISTS support_tickets (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER, username TEXT, message TEXT,
                status TEXT DEFAULT 'open', created_at TEXT,
                answered_at TEXT, answer TEXT);
            CREATE TABLE IF NOT EXISTS user_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER,
                event_type TEXT,
                event_data TEXT,
                timestamp TEXT);
            CREATE TABLE IF NOT EXISTS user_settings (
                user_id INTEGER PRIMARY KEY,
                language TEXT DEFAULT 'ru',
                created_at TEXT);
        """)
        try:
            self.conn.execute("ALTER TABLE support_tickets ADD COLUMN ticket_type TEXT DEFAULT 'question'")
        except sqlite3.OperationalError:
            pass
        self.conn.commit()

    def get_user_lang(self, uid):
        row = self.conn.execute(
            "SELECT language FROM user_settings WHERE user_id=?", (uid,)
        ).fetchone()
        return row["language"] if row else "ru"

    def set_user_lang(self, uid, lang):
        self.conn.execute(
            "INSERT OR REPLACE INTO user_settings (user_id, language, created_at) VALUES (?, ?, ?)",
            (uid, lang, datetime.now().isoformat())
        )
        self.conn.commit()

    def get_free_usage_stats(self, uid):
        now = datetime.now()
        start_of_day = now.replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
        start_of_month = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0).isoformat()
        daily = self.conn.execute(
            "SELECT COUNT(*) as c FROM user_events WHERE user_id=? AND event_type='free_request' AND timestamp>=?",
            (uid, start_of_day)).fetchone()["c"]
        monthly = self.conn.execute(
            "SELECT COUNT(*) as c FROM user_events WHERE user_id=? AND event_type='free_request' AND timestamp>=?",
            (uid, start_of_month)).fetchone()["c"]
        return daily, monthly

    def ban_user(self, uid, username="", reason="spam"):
        self.conn.execute(
            "INSERT OR REPLACE INTO banned_users VALUES (?,?,?,?)",
            (uid, username, reason, datetime.now().isoformat()))
        self.conn.commit()

    def unban_user(self, uid):
        self.conn.execute("DELETE FROM banned_users WHERE user_id=?", (uid,))
        self.conn.commit()

    def is_banned(self, uid):
        return self.conn.execute(
            "SELECT 1 FROM banned_users WHERE user_id=?", (uid,)).fetchone() is not None

    def get_banned_list(self):
        return self.conn.execute("SELECT * FROM banned_users").fetchall()

    def log_request(self, uid, uname):
        self.conn.execute(
            "INSERT INTO request_log (user_id,username_requested,timestamp) VALUES (?,?,?)",
            (uid, uname, datetime.now().isoformat()))
        self.conn.commit()

    def count_requests(self, uid, minutes):
        since = (datetime.now() - timedelta(minutes=minutes)).isoformat()
        return self.conn.execute(
            "SELECT COUNT(*) as cnt FROM request_log WHERE user_id=? AND timestamp>?",
            (uid, since)).fetchone()["cnt"]

    def check_rate_limit(self, uid):
        if self.count_requests(uid, 1) >= RATE_PER_MINUTE:
            return False, f"Лимит {RATE_PER_MINUTE}/мин."
        if self.count_requests(uid, 60) >= RATE_PER_HOUR:
            return False, f"Лимит {RATE_PER_HOUR}/час."
        if self.count_requests(uid, 1440) >= RATE_PER_DAY:
            return False, f"Лимит {RATE_PER_DAY}/сутки."
        return True, "ok"

    def cleanup_old_logs(self):
        c = (datetime.now() - timedelta(days=2)).isoformat()
        self.conn.execute("DELETE FROM request_log WHERE timestamp<?", (c,))
        self.conn.commit()

    def get_cache(self, username, mode, page=0):
        row = self.conn.execute(
            "SELECT data,cached_at FROM cache WHERE username=? AND mode=? AND page=?",
            (username, mode, page)).fetchone()
        if row and datetime.now() - datetime.fromisoformat(
                row["cached_at"]) < timedelta(minutes=CACHE_TTL_MINUTES):
            return json.loads(row["data"])
        return None

    def set_cache(self, username, mode, page, data):
        self.conn.execute(
            "INSERT OR REPLACE INTO cache VALUES (?,?,?,?,?)",
            (username, mode, page, json.dumps(data, ensure_ascii=False),
             datetime.now().isoformat()))
        self.conn.commit()

    def clear_expired_cache(self):
        c = (datetime.now() - timedelta(minutes=CACHE_TTL_MINUTES)).isoformat()
        self.conn.execute("DELETE FROM cache WHERE cached_at<?", (c,))
        self.conn.commit()

    def has_subscription(self, uid):
        row = self.conn.execute(
            "SELECT expires_at FROM subscriptions WHERE user_id=?", (uid,)).fetchone()
        return row and datetime.fromisoformat(row["expires_at"]) > datetime.now()

    def get_subscription_info(self, uid):
        row = self.conn.execute(
            "SELECT * FROM subscriptions WHERE user_id=?", (uid,)).fetchone()
        if row:
            exp = datetime.fromisoformat(row["expires_at"])
            return {
                "active": exp > datetime.now(),
                "expires_at": row["expires_at"],
                "days_left": max(0, (exp - datetime.now()).days),
                "method": row["payment_method"],
                "total_paid": row["total_paid"],
                "payments_count": row["payments_count"]}
        return None

    def activate_subscription(self, uid, method, amount=""):
        ex = self.conn.execute(
            "SELECT expires_at FROM subscriptions WHERE user_id=?", (uid,)).fetchone()
        if ex:
            cur = datetime.fromisoformat(ex["expires_at"])
            base = cur if cur > datetime.now() else datetime.now()
            ne = base + timedelta(days=SUBSCRIPTION_DAYS)
            self.conn.execute(
                "UPDATE subscriptions SET expires_at=?,payment_method=?,total_paid=total_paid+?,"
                "payments_count=payments_count+1 WHERE user_id=?",
                (ne.isoformat(), method, float(amount) if amount else 0, uid))
        else:
            ne = datetime.now() + timedelta(days=SUBSCRIPTION_DAYS)
            self.conn.execute(
                "INSERT INTO subscriptions VALUES (?,?,?,?,1)",
                (uid, ne.isoformat(), method, float(amount) if amount else 0))
        self.conn.execute(
            "INSERT INTO payments_log (user_id,amount,method,timestamp) VALUES (?,?,?,?)",
            (uid, str(amount), method, datetime.now().isoformat()))
        self.conn.commit()
        return ne

    def get_all_subscribers(self):
        return self.conn.execute(
            "SELECT * FROM subscriptions WHERE expires_at>?",
            (datetime.now().isoformat(),)).fetchall()

    def create_ticket(self, uid, username, message, ticket_type="question"):
        self.conn.execute(
            "INSERT INTO support_tickets (user_id,username,message,ticket_type,status,created_at) "
            "VALUES (?,?,?,?,'open',?)",
            (uid, username, message, ticket_type, datetime.now().isoformat()))
        self.conn.commit()
        return self.conn.execute("SELECT last_insert_rowid()").fetchone()[0]

    def answer_ticket(self, tid, answer):
        self.conn.execute(
            "UPDATE support_tickets SET status='answered',answer=?,answered_at=? WHERE id=?",
            (answer, datetime.now().isoformat(), tid))
        self.conn.commit()

    def get_open_tickets(self):
        return self.conn.execute(
            "SELECT * FROM support_tickets WHERE status='open' ORDER BY created_at DESC").fetchall()

    def get_ticket(self, tid):
        return self.conn.execute("SELECT * FROM support_tickets WHERE id=?", (tid,)).fetchone()

    def get_user_tickets(self, uid):
        return self.conn.execute(
            "SELECT * FROM support_tickets WHERE user_id=? ORDER BY created_at DESC LIMIT 5",
            (uid,)).fetchall()

    def log_event(self, uid, event_type, event_data=""):
        self.conn.execute(
            "INSERT INTO user_events (user_id,event_type,event_data,timestamp) VALUES (?,?,?,?)",
            (uid, event_type, event_data, datetime.now().isoformat()))
        self.conn.commit()

    def get_analytics(self, days=1):
        now = datetime.now()
        since = (now - timedelta(days=days)).isoformat()
        new_users = self.conn.execute(
            "SELECT COUNT(DISTINCT user_id) as c FROM user_events "
            "WHERE event_type='start' AND timestamp>?", (since,)).fetchone()["c"]
        new_subs = self.conn.execute(
            "SELECT COUNT(*) as c FROM user_events "
            "WHERE event_type='subscribe' AND timestamp>?", (since,)).fetchone()["c"]
        revenue = self.conn.execute(
            "SELECT SUM(total_paid) as s FROM subscriptions "
            "WHERE payment_method IS NOT NULL AND expires_at > datetime('now', '-30 days')"
        ).fetchone()["s"] or 0
        return {
            "new_users": new_users,
            "new_subscriptions": new_subs,
            "approx_revenue": revenue
        }


# ============================
# АККАУНТ
# ============================

class ThreadsAccount:
    def __init__(self, name, cookies_path):
        self.name = name
        self.cookies_path = cookies_path
        self.browser = self.page = self.context = None
        self.is_busy = self.is_alive = False
        self.last_error = None
        self.started_at = datetime.now()
        self.requests_count = self.posts_sent = self.errors_count = 0
        self.last_used = None
        self.lock = asyncio.Lock()
        self.hourly_requests = 0
        self.hourly_reset = datetime.now()
        self.last_cookie_save = None  # для авто-сохранения cookies

    def convert_cookies(self, cl):
        """Универсальный конвертер cookies (поддержка как Cookie-Editor JSON, так и Playwright формата)."""
        out = []
        for c in cl:
            ss = c.get("sameSite", "Lax")
            if ss in ("unspecified", None, ""):
                ss = "Lax"
            elif str(ss).lower() in ("no_restriction", "none"):
                ss = "None"
            elif str(ss).lower() == "lax":
                ss = "Lax"
            elif str(ss).lower() == "strict":
                ss = "Strict"

            ck = {
                "name": c["name"],
                "value": c["value"],
                "domain": c["domain"],
                "path": c.get("path", "/"),
                "httpOnly": bool(c.get("httpOnly", False)),
                "secure": bool(c.get("secure", True)),
                "sameSite": ss,
            }

            # Поддерживаем оба формата: expirationDate (Cookie-Editor) и expires (Playwright)
            exp = c.get("expirationDate", c.get("expires"))
            if isinstance(exp, (int, float)) and exp > 0:
                ck["expires"] = float(exp)

            out.append(ck)
        return out

    async def start(self, pw):
        try:
            cookies = self.convert_cookies(
                json.loads(self.cookies_path.read_text(encoding="utf-8")))
            self.browser = await pw.chromium.launch(headless=True)
            self.context = await self.browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
                           "AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                viewport={"width": 680, "height": 900})
            self.page = await self.context.new_page()
            await self.page.goto(BASE_URL + "/",
                                 wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(2)
            await self.context.add_cookies(cookies)
            await self.page.reload(wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(3)
            self.is_alive = True
            self.started_at = datetime.now()
            self.hourly_requests = 0
            self.hourly_reset = datetime.now()
            print(f"  ✅ {self.name} готов")
            return True
        except Exception as e:
            self.is_alive = False
            self.last_error = str(e)
            print(f"  ❌ {self.name}: {e}")
            return False

    async def save_cookies(self, force=False):
        """Сохраняет актуальные cookies обратно в accounts/name.json."""
        try:
            if not self.context:
                return
            if (not force and self.last_cookie_save
                    and datetime.now() - self.last_cookie_save < timedelta(minutes=15)):
                return
            cookies = await self.context.cookies()
            self.cookies_path.write_text(
                json.dumps(cookies, ensure_ascii=False, indent=2),
                encoding="utf-8"
            )
            self.last_cookie_save = datetime.now()
            print(f"  🍪 cookies сохранены: {self.name}")
        except Exception as e:
            print(f"  ⚠️ Не удалось сохранить cookies {self.name}: {e}")

    async def stop(self):
        # Сначала сохраняем cookies, потом закрываем браузер
        try:
            await self.save_cookies(force=True)
        except Exception:
            pass
        try:
            if self.browser:
                await self.browser.close()
        except Exception:
            pass
        self.is_alive = False
        self.browser = self.page = self.context = None

    async def health_check(self, pw):
        if self.is_alive: return True
        print(f"  [HEALTH] {self.name}...")
        await self.stop()
        await asyncio.sleep(2)
        return await self.start(pw)

    def check_hourly_limit(self):
        if datetime.now() - self.hourly_reset > timedelta(hours=1):
            self.hourly_requests = 0
            self.hourly_reset = datetime.now()
        return self.hourly_requests < ACCOUNT_HOURLY_LIMIT

    def increment_usage(self):
        self.hourly_requests += 1
        self.requests_count += 1
        self.last_used = datetime.now()

    def get_stats(self):
        up = datetime.now() - self.started_at
        return {
            "name": self.name, "is_alive": self.is_alive,
            "is_busy": self.is_busy,
            "uptime": f"{int(up.total_seconds()//3600)}ч"
                      f"{int((up.total_seconds()%3600)//60)}м",
            "requests": self.requests_count,
            "hourly": f"{self.hourly_requests}/{ACCOUNT_HOURLY_LIMIT}",
            "posts_sent": self.posts_sent, "errors": self.errors_count,
            "last_used": self.last_used.strftime("%H:%M:%S")
                         if self.last_used else "—",
            "last_error": self.last_error or "—"}


# ============================
# МЕНЕДЖЕР
# ============================

class AccountManager:
    def __init__(self, d):
        self.accounts: list[ThreadsAccount] = []
        self.accounts_dir = d
        self.playwright = None

    async def start_all(self):
        if not self.accounts_dir.exists():
            self.accounts_dir.mkdir(parents=True); return
        files = sorted(self.accounts_dir.glob("*.json"))
        if not files: print("⚠️ Нет куки"); return
        print(f"📦 {len(files)} аккаунтов")
        self.playwright = await async_playwright().start()
        for f in files:
            a = ThreadsAccount(f.stem, f)
            print(f"  🔄 {f.stem}...")
            await a.start(self.playwright)
            self.accounts.append(a)
        print(f"✅ {sum(1 for a in self.accounts if a.is_alive)}/{len(self.accounts)}")

    def mark_dead(self, a, e):
        a.is_alive = False; a.last_error = e; a.errors_count += 1

    def get_all_stats(self): return [a.get_stats() for a in self.accounts]

    def save_stats(self):
        STATS_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATS_FILE.write_text(json.dumps(
            {"accounts": self.get_all_stats(),
             "saved_at": datetime.now().isoformat()},
            indent=2, ensure_ascii=False, default=str), encoding="utf-8")

    async def reload_dead(self):
        r = []
        for a in self.accounts:
            if not a.is_alive:
                await a.stop(); await asyncio.sleep(1)
                r.append((a.name, await a.start(self.playwright)))
        return r


# ============================
# СКРОЛЛ И СБОР ПОСТОВ
# ============================

JS_COLLECT_POSTS = r"""() => {
    const posts = [];
    const seen = new Set();
    const containers = document.querySelectorAll('div[data-pressable-container="true"], article, div[role="article"]');

    for (let container of containers) {
        let bestText = "";
        let hasImage = false;
        let hasVideo = false;

        const images = container.querySelectorAll('img[src*="cdninstagram.com"], img[src*="fbcdn.net"]');
        const videos = container.querySelectorAll('video, div[role="button"] svg[aria-label*="video"], div[role="button"] svg[aria-label="Play"]');

        for (let img of images) {
            const width = img.naturalWidth || img.width || 0;
            if (width > 200) { hasImage = true; break; }
        }
        if (videos.length > 0) hasVideo = true;

        const textElements = container.querySelectorAll('span[dir="auto"], div[dir="auto"], span[class*="x1lliihq"]');
        for (let el of textElements) {
            const text = el.innerText.trim();
            if (text.length < 20) continue;
            if (/^(Follow|Подписаться|Translate|Перевести|See translation|See more|Like|Reply|Repost|Share|Verified|Автор|Ещё|Нравится|Поделиться)/i.test(text)) continue;
            if (/^\d+$/.test(text)) continue;
            if (/^\d{1,2}\s*[hчдms]$/i.test(text)) continue;
            if (text.length > bestText.length) bestText = text;
        }

        if (bestText.length > 25 || hasImage || hasVideo) {
            const key = bestText.substring(0, 100) + (hasImage ? "_img" : "") + (hasVideo ? "_vid" : "");
            if (!seen.has(key)) {
                seen.add(key);
                posts.push({text: bestText, has_image: hasImage, has_video: hasVideo});
            }
        }
    }
    return posts;
}"""


async def scroll_and_collect(page, target=20):
    all_t, seen, stall = [], set(), 0
    print(f"  [SCROLL] Начало сбора, цель: {target}")
    for i in range(35):
        try:
            cur = await page.evaluate(JS_COLLECT_POSTS)
        except Exception as e:
            print(f"  [SCROLL] JS Error: {e}"); break

        nw = 0
        for item in cur:
            text = item.get("text", "") if isinstance(item, dict) else item
            has_img = item.get("has_image", False) if isinstance(item, dict) else False
            has_vid = item.get("has_video", False) if isinstance(item, dict) else False
            cleaned = clean_post_text(text)
            if len(cleaned) < 15 and not has_img and not has_vid: continue
            k = cleaned[:120] + ("_img" if has_img else "") + ("_vid" if has_vid else "")
            if k not in seen:
                seen.add(k)
                all_t.append({"text": cleaned, "has_image": has_img, "has_video": has_vid})
                nw += 1

        print(f"  [SCROLL] {i+1:2d} | Получено: {len(cur):2d} | Новых: {nw:2d} | Всего: {len(all_t)}")
        if len(all_t) >= target: break
        if nw == 0:
            stall += 1
            if stall >= 6: break
        else: stall = 0
        await page.evaluate("window.scrollBy(0, 1100)")
        await asyncio.sleep(2.3)
    print(f"  [SCROLL] Итого: {len(all_t)}")
    return all_t


# ============================
# ПОЛУЧЕНИЕ ПОСТОВ
# ============================

async def get_threads_data(acc, username, mode="text", amount=20):
    page = acc.page
    async with acc.lock:
        try:
            await page.goto(f"{BASE_URL}/@{username}",
                            wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            raise Exception(f"goto: {e}")
        await asyncio.sleep(random.uniform(4.0, 6.0))
        try: pt = await page.inner_text("body")
        except Exception: pt = ""
        if any(m in pt for m in ["Page not found", "Страница не найдена",
                                  "isn't available", "недоступна"]):
            return None, "user_not_found"
        if "login" in page.url:
            await page.goto(BASE_URL + "/",
                            wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(3)
            if "login" in page.url: return None, "session_expired"
            return None, "user_not_found"
        try:
            await page.wait_for_selector("span[dir='auto'], div[dir='auto']", timeout=15000)
        except Exception: pass
        await asyncio.sleep(random.uniform(2.0, 3.0))
        texts = await scroll_and_collect(page, target=amount)
        if not texts: return None, "no_posts"
        texts = texts[:amount]
        if mode == "text": return texts, "ok"
        elif mode == "img":
            await page.evaluate("window.scrollTo(0,0)")
            await asyncio.sleep(2)
            await page.evaluate("""() => {
                document.querySelectorAll('div[role="dialog"]').forEach(e=>e.remove());
                document.querySelectorAll('nav,header').forEach(e=>e.style.display='none');
            }""")
            images = []
            for t in texts:
                try:
                    text_for_search = t["text"] if isinstance(t, dict) else t
                    safe = text_for_search[:50].replace("\\","\\\\").replace("`","\\`").replace("$","\\$")
                    eh = await page.evaluate_handle("""(searchText) => {
                        let posts = Array.from(document.querySelectorAll('article, div[role="article"]'));
                        if (!posts.length) posts = Array.from(document.querySelectorAll('div[data-pressable-container="true"]'));
                        for (let post of posts) {
                            const blocks = post.querySelectorAll('span[dir="auto"], div[dir="auto"]');
                            for (let b of blocks) {
                                if (b.innerText.trim().startsWith(searchText)) return post;
                            }
                        }
                        return null;
                    }""", safe)
                    el = eh.as_element()
                    if el:
                        await el.scroll_into_view_if_needed()
                        await asyncio.sleep(1)
                        img = await el.screenshot(type="png")
                        caption = text_for_search[:200]
                        images.append({"image": img, "text": caption})
                except Exception as ex:
                    print(f"  [IMG] {ex}"); continue
            return images, "ok"
        return None, "no_posts"


# ============================
# РОТАЦИЯ
# ============================

async def alert_admins(message_text):
    global last_alert_time
    now = time.time()
    if now - last_alert_time < ALERT_COOLDOWN:
        return
    last_alert_time = now
    for admin_id in ADMIN_IDS:
        try:
            await bot.send_message(admin_id, f"🚨 <b>ALERT</b>\n\n{message_text}")
        except Exception as e:
            print(f"Не удалось отправить алерт админу {admin_id}: {e}")


async def fetch_with_rotation(mgr, username, mode, amount=20):
    async with fetch_semaphore:
        tried = set()
        while True:
            avail = [a for a in mgr.accounts if a.is_alive and not a.is_busy
                     and a.name not in tried and a.check_hourly_limit()]
            if not avail:
                await asyncio.sleep(1)
                avail = [a for a in mgr.accounts if a.is_alive
                         and not a.is_busy and a.name not in tried]
            if not avail:
                avail = [a for a in mgr.accounts if a.is_alive and a.name not in tried]
            if not avail:
                await alert_admins(f"Все аккаунты недоступны!\nЗапрос: @{username}\nРежим: {mode}")
                return None, "all_dead", None

            acc = random.choice(avail); tried.add(acc.name); acc.is_busy = True
            try:
                print(f"[FETCH] {acc.name} -> @{username}")
                result, status = await get_threads_data(acc, username, mode, amount)
                acc.increment_usage()

                # Сохраняем cookies после успешного запроса
                if status == "ok":
                    await acc.save_cookies()

                acc.is_busy = False
                if status == "session_expired":
                    mgr.mark_dead(acc, "Session expired"); continue
                return result, status, acc
            except Exception as e:
                print(f"[FETCH] {acc.name}: {e}")
                acc.errors_count += 1; acc.is_busy = False
                mgr.mark_dead(acc, str(e))
                if "goto:" in str(e) or "timeout" in str(e).lower():
                    await alert_admins(f"Ошибка аккаунта {acc.name}:\n{str(e)[:200]}")
                continue


# ============================
# КОММЕНТАРИИ
# ============================

async def get_post_comments(acc, username, post_index, amount=20):
    page = acc.page
    async with acc.lock:
        try:
            await page.goto(f"{BASE_URL}/@{username}",
                            wait_until="domcontentloaded", timeout=30000)
        except Exception as e:
            raise Exception(f"goto: {e}")
        await asyncio.sleep(random.uniform(2, 3))
        if "login" in page.url:
            await page.goto(BASE_URL + "/",
                            wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(3)
            if "login" in page.url: return None, "session_expired"
            return None, "user_not_found"
        try:
            await page.wait_for_selector(
                "article,div[role='article'],div[data-pressable-container='true'],span[dir='auto']",
                timeout=10000)
        except Exception: pass
        await asyncio.sleep(2)
        texts = await scroll_and_collect(page, target=post_index + 3)
        if post_index >= len(texts): return None, "post_not_found"
        target_text = texts[post_index]
        text_content = target_text["text"] if isinstance(target_text, dict) else target_text
        print(f"  [CMT] пост: {text_content[:50]}...")
        safe = (text_content[:50].replace("\\", "\\\\")
                .replace("`", "\\`").replace("$", "\\$"))
        post_href = await page.evaluate("""(searchText) => {
            let posts = Array.from(document.querySelectorAll('article, div[role="article"]'));
            if (!posts.length) posts = Array.from(document.querySelectorAll('div[data-pressable-container="true"]'));
            for (let post of posts) {
                const blocks = post.querySelectorAll('span[dir="auto"], div[dir="auto"]');
                let found = false;
                for (let b of blocks) {
                    if (b.innerText.trim().startsWith(searchText.substring(0,50))) { found = true; break; }
                }
                if (!found) continue;
                const links = post.querySelectorAll('a[href]');
                for (let l of links) {
                    const h = l.getAttribute('href');
                    if (h && h.includes('/post/')) return h;
                }
                const timeLinks = post.querySelectorAll('a time');
                for (let tl of timeLinks) {
                    const parent = tl.parentElement;
                    if (parent && parent.getAttribute('href') && parent.getAttribute('href').includes('/post/'))
                        return parent.getAttribute('href');
                }
            }
            return null;
        }""", safe)
        print(f"  [CMT] href: {post_href}")
        if not post_href:
            clicked = await page.evaluate("""(s) => {
                const blocks = document.querySelectorAll('span[dir="auto"], div[dir="auto"]');
                for (let b of blocks) {
                    if (b.innerText.trim().startsWith(s.substring(0,50))) { b.click(); return true; }
                }
                return false;
            }""", safe)
            if clicked:
                try:
                    await page.wait_for_url(lambda url: "/post/" in url, timeout=8000)
                except Exception: pass
                await asyncio.sleep(3)
                if "/post/" not in page.url: return None, "post_not_found"
            else:
                return None, "post_not_found"
        else:
            full = (f"{BASE_URL}{post_href}" if post_href.startswith("/") else post_href)
            print(f"  [CMT] -> {full}")
            await page.goto(full, wait_until="domcontentloaded", timeout=30000)
        await asyncio.sleep(4)
        print(f"  [CMT] URL: {page.url}")
        if "/post/" not in page.url: return None, "post_not_found"
        await page.evaluate("window.scrollBy(0, 800)")
        await asyncio.sleep(2)
        comments = await collect_comments(page, target=amount)
        return comments, "ok"


async def collect_comments(page, target=20, root_author=None):
    all_comments = []
    seen = set()
    stall = 0
    print("  [CMT] Сбор комментариев...")
    await asyncio.sleep(3)
    for attempt in range(20):
        try:
            current = await page.evaluate(r"""(rootAuthor) => {
                const results = [];
                const containers = Array.from(document.querySelectorAll('div[data-pressable-container="true"]'));
                for (const container of containers) {
                    const rect = container.getBoundingClientRect();
                    const topPos = rect.top + window.scrollY;
                    let author = '';
                    const authorLink = container.querySelector('a[href^="/@"][role="link"]');
                    if (authorLink) {
                        const href = authorLink.getAttribute('href') || '';
                        const match = href.match(/\/@([A-Za-z0-9._]+)/);
                        if (match) author = '@' + match[1].toLowerCase();
                    }
                    let text = '';
                    const textSpans = container.querySelectorAll('span[dir="auto"] > span');
                    for (const sp of textSpans) {
                        const t = (sp.innerText || '').trim();
                        if (!t) continue;
                        if (author && (t.toLowerCase() === author.replace('@','') || t.toLowerCase() === author)) continue;
                        if (/^(Follow|Подписаться|Translate|Перевести|Reply|Ответ|Repost|Share|Send|Like|More|Verified|See translation|Показать перевод|Автор|Author|Ещё|Нравится|Поделиться|Сделать репост|Поставить)$/i.test(t)) continue;
                        if (/^\d+$/.test(t)) continue;
                        if (/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(t)) continue;
                        if (/^\d+\s*[hHчмсmsdд]$/.test(t)) continue;
                        if (/^\d+\s*\/\s*\d+$/.test(t)) continue;
                        if (t.length > text.length) text = t;
                    }
                    if (!text) {
                        const spans = container.querySelectorAll('span[dir="auto"]');
                        for (const sp of spans) {
                            const t = (sp.innerText || '').trim();
                            if (!t || t.length < 3) continue;
                            if (author && (t.toLowerCase() === author.replace('@','') || t.toLowerCase() === author)) continue;
                            if (/^(Follow|Подписаться|Translate|Перевести|Reply|Ответ|Verified|Author|Автор|Ещё|Like|More)$/i.test(t)) continue;
                            if (/^\d+$/.test(t)) continue;
                            if (/^\d{1,2}\.\d{1,2}\.\d{2,4}$/.test(t)) continue;
                            if (/^\d+\s*[hHчмсmsdд]$/.test(t)) continue;
                            if (/^\d+\s*\/\s*\d+$/.test(t)) continue;
                            if (t.length > text.length) text = t;
                        }
                    }
                    if (!text) continue;
                    const hasLetters = /[A-Za-zА-Яа-яÀ-ÿ\u0400-\u04FF\u4e00-\u9fff\u3040-\u30ff]/.test(text);
                    if (!hasLetters) continue;
                    const key = ((author || '-') + '|' + text.substring(0, 120)).toLowerCase();
                    results.push({author: author || '—', text: text, key: key, top: topPos});
                }
                results.sort((a, b) => a.top - b.top);
                let startIdx = 0;
                if (rootAuthor) {
                    const ra = rootAuthor.toLowerCase();
                    while (startIdx < results.length && results[startIdx].author === ra) startIdx++;
                } else { startIdx = 1; }
                return results.slice(startIdx);
            }""", root_author)
        except Exception as e:
            print(f"  [CMT] JS error: {e}"); break
        nw = 0
        for item in current:
            if item["key"] not in seen:
                seen.add(item["key"])
                item["text"] = clean_post_text(item["text"])
                all_comments.append(item)
                nw += 1
        all_comments.sort(key=lambda x: x.get("top", 0))
        print(f"  [CMT] {attempt+1}: found={len(current)} new={nw} total={len(all_comments)}")
        if len(all_comments) >= target: break
        if nw == 0:
            stall += 1
            if stall >= 3: break
        else: stall = 0
        await page.evaluate("window.scrollBy(0, 1200)")
        await asyncio.sleep(2.5)
    all_comments.sort(key=lambda x: x.get("top", 0))
    print(f"  [CMT] ИТОГО: {len(all_comments)}")
    return all_comments


async def fetch_comments_rotation(mgr, username, post_index, amount=20):
    async with fetch_semaphore:
        tried = set()
        while True:
            avail = [a for a in mgr.accounts if a.is_alive and not a.is_busy
                     and a.name not in tried and a.check_hourly_limit()]
            if not avail:
                await asyncio.sleep(1)
                avail = [a for a in mgr.accounts if a.is_alive and not a.is_busy and a.name not in tried]
            if not avail:
                avail = [a for a in mgr.accounts if a.is_alive and a.name not in tried]
            if not avail:
                await alert_admins(f"Все аккаунты недоступны при сборе комментариев!\n@{username}, пост #{post_index}")
                return None, "all_dead", None
            acc = random.choice(avail); tried.add(acc.name); acc.is_busy = True
            try:
                print(f"[CMT] {acc.name} -> @{username} #{post_index}")
                result, status = await get_post_comments(acc, username, post_index, amount)
                acc.increment_usage()

                # Сохраняем cookies после успешного запроса
                if status == "ok":
                    await acc.save_cookies()

                acc.is_busy = False
                if status == "session_expired":
                    mgr.mark_dead(acc, "Session expired"); continue
                return result, status, acc
            except Exception as e:
                print(f"[CMT] {acc.name}: {e}")
                acc.errors_count += 1; acc.is_busy = False
                mgr.mark_dead(acc, str(e)); continue


# ============================
# CRYPTOBOT
# ============================

async def create_crypto_invoice(uid):
    headers = {"Crypto-Pay-API-Token": CRYPTO_BOT_TOKEN}
    payload = {
        "asset": "USDT", "amount": str(PRICE_CRYPTO_USD),
        "description": "Threads Bot Subscription — 30 days",
        "payload": str(uid), "paid_btn_name": "callback",
        "paid_btn_url": f"https://t.me/{(await bot.get_me()).username}"}
    async with aiohttp.ClientSession() as s:
        async with s.post("https://pay.crypt.bot/api/createInvoice",
                          headers=headers, json=payload) as r:
            data = await r.json()
            if data.get("ok"):
                return data["result"]["pay_url"], data["result"]["invoice_id"]
    return None, None


async def check_crypto_invoice(inv_id):
    headers = {"Crypto-Pay-API-Token": CRYPTO_BOT_TOKEN}
    async with aiohttp.ClientSession() as s:
        async with s.get("https://pay.crypt.bot/api/getInvoices",
                         headers=headers, params={"invoice_ids": str(inv_id)}) as r:
            data = await r.json()
            if data.get("ok") and data["result"]["items"]:
                return data["result"]["items"][0]["status"] == "paid"
    return False


# ============================
# ИНИЦИАЛИЗАЦИЯ
# ============================

manager = AccountManager(ACCOUNTS_DIR)
tg_session = AiohttpSession(timeout=60)
bot = Bot(token=TELEGRAM_TOKEN, session=tg_session,
          default=DefaultBotProperties(parse_mode="HTML"))
dp = Dispatcher()
db = Database(DB_FILE)

fetch_semaphore: asyncio.Semaphore = None
last_button_message: dict[int, int] = {}
waiting_support: dict[int, str] = {}
admin_replying: dict[int, int] = {}
last_requested_username: dict[int, str] = {}


# ============================
# ФИЛЬТРЫ
# ============================

class WaitingSupportFilter(BaseFilter):
    async def __call__(self, message: Message) -> bool:
        return bool(message.from_user and message.from_user.id in waiting_support)


class AdminReplyFilter(BaseFilter):
    async def __call__(self, message: Message) -> bool:
        return bool(message.from_user and message.from_user.id in admin_replying)


# ============================
# ВСПОМОГАТЕЛЬНЫЕ
# ============================

async def remove_old_buttons(cid):
    if cid in last_button_message:
        try:
            await bot.edit_message_reply_markup(
                chat_id=cid, message_id=last_button_message[cid], reply_markup=None)
        except Exception: pass
        del last_button_message[cid]


async def send_with_buttons(cid, text, kb):
    await remove_old_buttons(cid)
    msg = await bot.send_message(cid, text, reply_markup=kb)
    last_button_message[cid] = msg.message_id


def is_admin(uid): return uid in ADMIN_IDS


def check_access(uid):
    lang = db.get_user_lang(uid)
    if is_admin(uid):
        return True, "", "ok"
    if db.has_subscription(uid):
        return True, "", "ok"

    daily, monthly = db.get_free_usage_stats(uid)
    if monthly >= FREE_MONTHLY_LIMIT:
        return False, get_text('monthly_limit_reached', lang), "month_limit"
    if daily >= FREE_DAILY_LIMIT:
        return False, get_text('daily_limit_reached', lang, limit=FREE_DAILY_LIMIT), "day_limit"

    left_today = FREE_DAILY_LIMIT - daily
    left_month = FREE_MONTHLY_LIMIT - monthly
    return True, get_text('free_limit', lang, daily=left_today, monthly=left_month), "ok"


async def send_ticket_to_admins(tid, uid, username, text_value, ticket_type):
    type_emoji = "💡" if ticket_type == "suggestion" else "❓"
    type_label = "Suggestion" if ticket_type == "suggestion" else "Question"
    for aid in ADMIN_IDS:
        try:
            kb = InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text="💬 Reply", callback_data=f"ticket:reply:{tid}")]])
            await bot.send_message(
                aid,
                f"🆘 {type_emoji} <b>#{tid} ({type_label})</b>\n"
                f"👤 @{username or uid} (<code>{uid}</code>)\n"
                f"📝 {text_value[:500]}",
                reply_markup=kb)
        except Exception: pass


# ============================
# ЕЖЕДНЕВНЫЙ ОТЧЁТ
# ============================

async def daily_report():
    await asyncio.sleep(10)
    while True:
        now = datetime.now()
        target = now.replace(hour=9, minute=0, second=0, microsecond=0)
        if target < now:
            target += timedelta(days=1)
        wait_seconds = (target - now).total_seconds()
        print(f"[REPORT] Следующий отчёт через {wait_seconds/3600:.1f} часов")
        await asyncio.sleep(wait_seconds)

        stats = db.get_analytics(days=1)
        alive = sum(1 for a in manager.accounts if a.is_alive)
        total = len(manager.accounts)
        open_tickets = len(db.get_open_tickets())

        report_text = (
            f"📊 <b>Daily Report</b> ({datetime.now().strftime('%d.%m.%Y')})\n\n"
            f"👥 <b>Users:</b>\n"
            f"   New today: {stats['new_users']}\n"
            f"   New subs: {stats['new_subscriptions']}\n\n"
            f"💰 <b>Revenue (approx):</b> ${stats['approx_revenue']:.2f}\n\n"
            f"🤖 <b>Accounts:</b> {alive}/{total} alive\n\n"
            f"🆘 <b>Open tickets:</b> {open_tickets}"
        )

        for admin_id in ADMIN_IDS:
            try:
                await bot.send_message(admin_id, report_text)
            except Exception as e:
                print(f"[REPORT] {e}")
        await asyncio.sleep(86400)


# ============================
# КОМАНДЫ
# ============================

@dp.message(Command("start"))
async def cmd_start(message: Message):
    uid = message.from_user.id

    # Первый старт — предлагаем выбор языка
    events = db.conn.execute(
        "SELECT 1 FROM user_events WHERE user_id=?", (uid,)
    ).fetchone()
    has_lang = db.conn.execute(
        "SELECT 1 FROM user_settings WHERE user_id=?", (uid,)
    ).fetchone()

    if not events or not has_lang:
        # Авто-определение языка по Telegram
        tg_lang = (message.from_user.language_code or "ru")[:2]
        if tg_lang not in TRANSLATIONS:
            tg_lang = 'en'
        db.set_user_lang(uid, tg_lang)

        kb = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text=LANGUAGE_NAMES['ru'], callback_data="set_lang:ru"),
             InlineKeyboardButton(text=LANGUAGE_NAMES['en'], callback_data="set_lang:en")],
            [InlineKeyboardButton(text=LANGUAGE_NAMES['de'], callback_data="set_lang:de"),
             InlineKeyboardButton(text=LANGUAGE_NAMES['es'], callback_data="set_lang:es")],
            [InlineKeyboardButton(text=LANGUAGE_NAMES['pt'], callback_data="set_lang:pt")],
        ])
        await message.answer("🌍 Выберите язык / Select language / Sprache wählen / Selecciona idioma / Selecione o idioma:",
                             reply_markup=kb)
        return

    await remove_old_buttons(message.chat.id)
    db.log_event(uid, "start")
    lang = db.get_user_lang(uid)

    if db.has_subscription(uid):
        info = db.get_subscription_info(uid)
        status = get_text('subscription_active', lang, days=info['days_left'])
    else:
        daily, monthly = db.get_free_usage_stats(uid)
        left_today = max(0, FREE_DAILY_LIMIT - daily)
        left_month = max(0, FREE_MONTHLY_LIMIT - monthly)
        status = get_text('free_limit', lang, daily=left_today, monthly=left_month)

    await message.answer(get_text('welcome', lang, status=status))


@dp.callback_query(F.data.startswith("set_lang:"))
async def set_language(cb: CallbackQuery):
    lang = cb.data.split(":")[1]
    if lang not in TRANSLATIONS:
        lang = 'en'
    db.set_user_lang(cb.from_user.id, lang)
    await cb.answer(get_text('language_set', lang))
    try:
        await cb.message.delete()
    except Exception:
        pass
    # Заново вызываем /start
    fake = cb.message
    fake.from_user = cb.from_user
    await cmd_start(fake)


@dp.message(Command("language"))
async def cmd_language(message: Message):
    """Команда для смены языка в любой момент"""
    await remove_old_buttons(message.chat.id)
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=LANGUAGE_NAMES['ru'], callback_data="set_lang:ru"),
         InlineKeyboardButton(text=LANGUAGE_NAMES['en'], callback_data="set_lang:en")],
        [InlineKeyboardButton(text=LANGUAGE_NAMES['de'], callback_data="set_lang:de"),
         InlineKeyboardButton(text=LANGUAGE_NAMES['es'], callback_data="set_lang:es")],
        [InlineKeyboardButton(text=LANGUAGE_NAMES['pt'], callback_data="set_lang:pt")],
    ])
    lang = db.get_user_lang(message.from_user.id)
    await message.answer(get_text('select_language', lang), reply_markup=kb)


@dp.message(Command("help"))
async def cmd_help(message: Message):
    lang = db.get_user_lang(message.from_user.id)
    await remove_old_buttons(message.chat.id)
    text = get_text('help', lang)
    if is_admin(message.from_user.id):
        text += "\n\n🔐 /admin"
    await message.answer(text)


# ============================
# ПОДПИСКА
# ============================

@dp.message(Command("subscribe"))
async def cmd_subscribe(message: Message):
    await remove_old_buttons(message.chat.id)
    uid = message.from_user.id
    lang = db.get_user_lang(uid)

    if db.has_subscription(uid):
        i = db.get_subscription_info(uid)
        kb = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="🔄 " + get_text('renew', lang), callback_data="sub:choose")]])
        await send_with_buttons(message.chat.id,
            f"✅ {get_text('until', lang)} {i['expires_at'][:10]} ({i['days_left']} {get_text('days', lang)})", kb)
        return

    daily, monthly = db.get_free_usage_stats(uid)
    left_today = max(0, FREE_DAILY_LIMIT - daily)

    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="💳 " + get_text('subscribe', lang), callback_data="sub:choose")]])
    await send_with_buttons(message.chat.id,
        f"📱 <b>{get_text('subscription', lang)} — 30 {get_text('days', lang)}</b>\n"
        f"✅ {get_text('unlimited', lang)}\n"
        f"🆓 {get_text('left_today', lang)}: {left_today}", kb)


@dp.message(Command("status"))
async def cmd_status(message: Message):
    uid = message.from_user.id
    lang = db.get_user_lang(uid)
    i = db.get_subscription_info(uid)
    if i and i["active"]:
        await message.answer(
            f"✅ <b>{get_text('active', lang)}</b> {get_text('until', lang)} {i['expires_at'][:10]} "
            f"({i['days_left']} {get_text('days', lang)})")
    else:
        daily, monthly = db.get_free_usage_stats(uid)
        left_today = max(0, FREE_DAILY_LIMIT - daily)
        await message.answer(
            f"❌ <b>{get_text('no_sub_short', lang)}</b>\n"
            f"🆓 {get_text('left_today', lang)}: {left_today}\n/subscribe")


@dp.callback_query(F.data == "sub:choose")
async def sub_choose(cb: CallbackQuery):
    await cb.answer()
    lang = db.get_user_lang(cb.from_user.id)
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text=f"⭐ Stars ({PRICE_STARS}⭐)", callback_data="sub:stars")],
        [InlineKeyboardButton(text=f"💎 Crypto ({PRICE_CRYPTO_USD}$)", callback_data="sub:crypto")]])
    await send_with_buttons(cb.message.chat.id, get_text('payment_method', lang), kb)


@dp.callback_query(F.data == "sub:stars")
async def sub_stars(cb: CallbackQuery):
    await cb.answer()
    lang = db.get_user_lang(cb.from_user.id)
    await bot.send_invoice(
        chat_id=cb.message.chat.id,
        title=get_text('subscription', lang) + " Threads Bot",
        description=f"30 {get_text('days', lang)}",
        payload=f"sub_{cb.from_user.id}", currency="XTR",
        prices=[LabeledPrice(label=get_text('subscription', lang), amount=PRICE_STARS)])


@dp.pre_checkout_query()
async def pre_checkout(q: PreCheckoutQuery):
    await q.answer(ok=True)


@dp.message(F.successful_payment)
async def success_pay(msg: Message):
    uid = msg.from_user.id
    lang = db.get_user_lang(uid)
    exp = db.activate_subscription(uid, "stars", str(msg.successful_payment.total_amount))
    db.log_event(uid, "subscribe", "stars")
    await msg.answer(f"🎉 <b>{get_text('paid', lang)}!</b> {get_text('until', lang)} {exp.strftime('%d.%m.%Y')}")


@dp.callback_query(F.data == "sub:crypto")
async def sub_crypto(cb: CallbackQuery):
    await cb.answer()
    lang = db.get_user_lang(cb.from_user.id)
    url, inv = await create_crypto_invoice(cb.from_user.id)
    if not url:
        await bot.send_message(cb.message.chat.id, "❌ Error."); return
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="💎 " + get_text('pay', lang), url=url)],
        [InlineKeyboardButton(text="✅ " + get_text('i_paid', lang), callback_data=f"sub:check:{inv}")]])
    await send_with_buttons(cb.message.chat.id,
        f"💎 <b>{PRICE_CRYPTO_USD} USDT</b>\n{get_text('after_payment', lang)} «{get_text('i_paid', lang)}».", kb)


@dp.callback_query(F.data.startswith("sub:check:"))
async def sub_check(cb: CallbackQuery):
    inv = int(cb.data.split(":")[2])
    lang = db.get_user_lang(cb.from_user.id)
    if await check_crypto_invoice(inv):
        uid = cb.from_user.id
        exp = db.activate_subscription(uid, "crypto", str(PRICE_CRYPTO_USD))
        db.log_event(uid, "subscribe", "crypto")
        await cb.answer("✅!", show_alert=True)
        await cb.message.edit_text(
            f"🎉 <b>{get_text('paid', lang)}!</b> {get_text('until', lang)} {exp.strftime('%d.%m.%Y')}")
    else:
        await cb.answer("⏳ " + get_text('not_found', lang), show_alert=True)


# ============================
# ПОДДЕРЖКА
# ============================

@dp.message(Command("support"))
async def cmd_support(msg: Message):
    await remove_old_buttons(msg.chat.id)
    lang = db.get_user_lang(msg.from_user.id)
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="❓ " + get_text('question', lang), callback_data="sup:write:question")],
        [InlineKeyboardButton(text="💡 " + get_text('suggestion', lang), callback_data="sup:write:suggestion")],
        [InlineKeyboardButton(text="📋 " + get_text('my_tickets', lang), callback_data="sup:my")]])
    await send_with_buttons(msg.chat.id,
        f"<b>{get_text('support_title', lang)}</b>\n\n"
        f"• {get_text('ask_question', lang)}\n"
        f"• {get_text('suggest_idea', lang)}\n\n{get_text('choose', lang)} 👇", kb)


@dp.callback_query(F.data.startswith("sup:write:"))
async def sup_write(cb: CallbackQuery):
    await cb.answer()
    ticket_type = cb.data.split(":")[2]
    waiting_support[cb.from_user.id] = ticket_type
    lang = db.get_user_lang(cb.from_user.id)
    try:
        await cb.message.edit_reply_markup(reply_markup=None)
    except Exception: pass
    label = get_text('suggestion' if ticket_type == "suggestion" else 'question', lang)
    emoji = "💡" if ticket_type == "suggestion" else "❓"
    prompt = f"{emoji} <b>{label}</b>\n\nSend your message:"
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="❌ Cancel", callback_data="sup:cancel")]])
    await send_with_buttons(cb.message.chat.id, prompt, kb)


@dp.callback_query(F.data == "sup:cancel")
async def sup_cancel(cb: CallbackQuery):
    await cb.answer()
    waiting_support.pop(cb.from_user.id, None)
    await cb.message.edit_text("❌ Cancelled.")


@dp.callback_query(F.data == "sup:my")
async def sup_my(cb: CallbackQuery):
    await cb.answer()
    lang = db.get_user_lang(cb.from_user.id)
    tickets = db.get_user_tickets(cb.from_user.id)
    if not tickets:
        text = "📋 " + get_text('my_tickets', lang) + ": —"
    else:
        text = f"📋 <b>{get_text('my_tickets', lang)}:</b>\n\n"
        for t in tickets:
            s = "✅" if t["status"] == "answered" else "⏳"
            tt = t["ticket_type"] if "ticket_type" in t.keys() else "question"
            tp = "💡" if tt == "suggestion" else "❓"
            text += f"{s}{tp} <b>#{t['id']}</b> ({t['created_at'][:10]})\n   {t['message'][:80]}\n"
            if t["answer"]:
                text += f"   💬 {t['answer'][:80]}\n"
            text += "\n"
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="❓ " + get_text('question', lang), callback_data="sup:write:question"),
        InlineKeyboardButton(text="💡 " + get_text('suggestion', lang), callback_data="sup:write:suggestion")]])
    await send_with_buttons(cb.message.chat.id, text, kb)


@dp.callback_query(F.data.startswith("ticket:reply:"))
async def ticket_reply(cb: CallbackQuery):
    if not is_admin(cb.from_user.id): return
    tid = int(cb.data.split(":")[2])
    admin_replying[cb.from_user.id] = tid
    await cb.answer()
    try:
        await cb.message.edit_reply_markup(reply_markup=None)
    except Exception: pass
    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="❌ Cancel", callback_data="ticket:cancel")]])
    await send_with_buttons(cb.message.chat.id, f"💬 Reply to <b>#{tid}</b>:", kb)


@dp.callback_query(F.data == "ticket:cancel")
async def ticket_cancel(cb: CallbackQuery):
    admin_replying.pop(cb.from_user.id, None)
    await cb.answer()
    await cb.message.edit_text("❌ Cancelled.")


@dp.message(WaitingSupportFilter())
async def handle_support_input(message: Message):
    uid = message.from_user.id
    ticket_type = waiting_support.pop(uid)
    text_value = message.text or message.caption or ""
    if not text_value.strip():
        await message.answer("❌ Empty message."); return
    tid = db.create_ticket(uid, message.from_user.username or str(uid), text_value, ticket_type)
    db.log_event(uid, "ticket", ticket_type)
    lang = db.get_user_lang(uid)
    label = get_text('suggestion' if ticket_type == "suggestion" else 'question', lang)
    await message.answer(f"✅ <b>{label} #{tid}</b>")
    await send_ticket_to_admins(tid, uid, message.from_user.username, text_value, ticket_type)


@dp.message(AdminReplyFilter())
async def handle_admin_reply_input(message: Message):
    uid = message.from_user.id
    tid = admin_replying.pop(uid)
    ticket = db.get_ticket(tid)
    if not ticket:
        await message.answer("❌ Ticket not found."); return
    answer_text = message.text or message.caption or ""
    if not answer_text.strip():
        await message.answer("❌ Empty answer."); return
    db.answer_ticket(tid, answer_text)
    try:
        await bot.send_message(ticket["user_id"], f"💬 <b>Reply to #{tid}</b>\n\n{answer_text}")
    except Exception: pass
    await message.answer(f"✅ Reply #{tid} sent.")


# ============================
# АДМИН
# ============================

@dp.message(Command("admin"))
async def cmd_admin(msg: Message):
    if not is_admin(msg.from_user.id): return
    await remove_old_buttons(msg.chat.id)
    alive = sum(1 for a in manager.accounts if a.is_alive)
    total = len(manager.accounts)
    subs = len(db.get_all_subscribers())
    ot = len(db.get_open_tickets())
    kb = InlineKeyboardMarkup(inline_keyboard=[
        [InlineKeyboardButton(text="📊 Stats", callback_data="adm:stats"),
         InlineKeyboardButton(text="🏥 Health", callback_data="adm:health")],
        [InlineKeyboardButton(text="🔄 Reload", callback_data="adm:reload"),
         InlineKeyboardButton(text="📋 Detailed", callback_data="adm:detailed")],
        [InlineKeyboardButton(text="🚫 Bans", callback_data="adm:banlist"),
         InlineKeyboardButton(text="👥 Subs", callback_data="adm:subs")],
        [InlineKeyboardButton(text=f"🆘 Tickets ({ot})", callback_data="adm:tickets")],
        [InlineKeyboardButton(text="📈 Analytics", callback_data="adm:analytics")]])
    await send_with_buttons(msg.chat.id,
        f"🔐 <b>Admin</b>\n🟢{alive}/{total} | 👥{subs} | 🆘{ot}", kb)


@dp.message(Command("ban"))
async def cmd_ban(msg: Message):
    if not is_admin(msg.from_user.id): return
    p = msg.text.split(maxsplit=2)
    if len(p) < 2: await msg.answer("<code>/ban ID</code>"); return
    try: uid = int(p[1])
    except ValueError: await msg.answer("❌"); return
    db.ban_user(uid, reason=p[2] if len(p) > 2 else "ban")
    await msg.answer(f"🚫 {uid} banned")


@dp.message(Command("unban"))
async def cmd_unban(msg: Message):
    if not is_admin(msg.from_user.id): return
    p = msg.text.split()
    if len(p) < 2: await msg.answer("<code>/unban ID</code>"); return
    try: uid = int(p[1])
    except ValueError: await msg.answer("❌"); return
    db.unban_user(uid); await msg.answer(f"✅ {uid} unbanned")


@dp.callback_query(F.data.startswith("adm:"))
async def handle_admin(cb: CallbackQuery):
    if not is_admin(cb.from_user.id):
        await cb.answer("⛔", show_alert=True); return
    act = cb.data.split(":")[1]; await cb.answer(); cid = cb.message.chat.id
    back = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text="◀️", callback_data="adm:back")]])

    if act == "stats":
        stats = manager.get_all_stats()
        text = "📊 <b>Stats</b>\n\n"
        tr = tp = te = 0
        for s in stats:
            text += (f"{'🟢' if s['is_alive'] else '🔴'} <b>{s['name']}</b>\n"
                     f"   ⏱{s['uptime']}|📨{s['requests']}|⏰{s['hourly']}\n"
                     f"   📝{s['posts_sent']}|❌{s['errors']}|🕐{s['last_used']}\n\n")
            tr += s["requests"]; tp += s["posts_sent"]; te += s["errors"]
        alive = sum(1 for s in stats if s["is_alive"])
        text += f"{'━'*20}\n🟢{alive}/{len(stats)}|📨{tr}|📝{tp}|❌{te}"
        await send_with_buttons(cid, text, back); manager.save_stats()

    elif act == "health":
        text = "🏥 <b>Health</b>\n\n"
        for a in manager.accounts:
            s = a.get_stats()
            text += (f"{'🟢' if a.is_alive else '🔴'} {a.name} "
                     f"⏰{s['hourly']}{'  (busy)' if a.is_busy else ''}\n")
        kb = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text="🔄", callback_data="adm:reload"),
            InlineKeyboardButton(text="◀️", callback_data="adm:back")]])
        await send_with_buttons(cid, text, kb)

    elif act == "reload":
        dead = [a for a in manager.accounts if not a.is_alive]
        if not dead:
            await send_with_buttons(cid, "✅ All ok!", back); return
        await bot.send_message(cid, f"🔄 {len(dead)}...")
        r = await manager.reload_dead()
        text = "🔄\n" + "".join(f"{'🟢' if ok else '🔴'} {n}\n" for n, ok in r)
        global fetch_semaphore
        alive = sum(1 for a in manager.accounts if a.is_alive)
        fetch_semaphore = asyncio.Semaphore(max(1, alive))
        text += f"\n🔒 Sem: {alive}"
        await send_with_buttons(cid, text, back)

    elif act == "detailed":
        text = "📋 <b>Details</b>\n\n"
        for a in manager.accounts:
            s = a.get_stats()
            text += (f"{'🟢' if s['is_alive'] else '🔴'} <b>{s['name']}</b>\n"
                     f"   {s['uptime']}|req:{s['requests']}({s['hourly']})\n"
                     f"   posts:{s['posts_sent']}|err:{s['errors']}\n"
                     f"   {s['last_used']}|{s['last_error']}\n\n")
        await send_with_buttons(cid, text, back)

    elif act == "banlist":
        b = db.get_banned_list()
        text = ("🚫 Empty" if not b else
                f"🚫 ({len(b)})\n\n" + "".join(
                    f"• <code>{r['user_id']}</code> — {r['reason']}\n" for r in b))
        await send_with_buttons(cid, text, back)

    elif act == "subs":
        subs = db.get_all_subscribers()
        if not subs:
            text = "👥 None"
        else:
            text = f"👥 ({len(subs)})\n\n"
            for s in subs:
                d = max(0, (datetime.fromisoformat(s["expires_at"]) - datetime.now()).days)
                text += f"• <code>{s['user_id']}</code> {d}d|{s['payment_method']}\n"
        await send_with_buttons(cid, text, back)

    elif act == "analytics":
        a = db.get_analytics()
        text = (
            f"📈 <b>Analytics</b>\n\n"
            f"👥 New users (1d): {a['new_users']}\n"
            f"💰 New subs (1d): {a['new_subscriptions']}\n"
            f"💵 Revenue (30d): ${a['approx_revenue']:.2f}")
        await send_with_buttons(cid, text, back)

    elif act == "tickets":
        tickets = db.get_open_tickets()
        if not tickets:
            text = "🆘 No open tickets."
        else:
            text = f"🆘 Open ({len(tickets)}):\n\n"
            for tk in tickets[:10]:
                row_dict = dict(tk)
                ticket_type = row_dict.get("ticket_type", "question")
                tp = "💡" if ticket_type == "suggestion" else "❓"
                username = row_dict.get("username") or str(row_dict.get("user_id", ""))
                m = (row_dict.get("message") or "")[:80]
                text += f"{tp} <b>#{row_dict['id']}</b> @{username} ({row_dict['created_at'][:10]})\n   {m}\n\n"
            text += "\n💬 <b>Quick reply:</b> <code>ID text</code>"
        await send_with_buttons(cid, text, back)

    elif act == "back":
        alive = sum(1 for a in manager.accounts if a.is_alive)
        total = len(manager.accounts)
        subs = len(db.get_all_subscribers())
        ot = len(db.get_open_tickets())
        kb = InlineKeyboardMarkup(inline_keyboard=[
            [InlineKeyboardButton(text="📊 Stats", callback_data="adm:stats"),
             InlineKeyboardButton(text="🏥 Health", callback_data="adm:health")],
            [InlineKeyboardButton(text="🔄 Reload", callback_data="adm:reload"),
             InlineKeyboardButton(text="📋 Detailed", callback_data="adm:detailed")],
            [InlineKeyboardButton(text="🚫 Bans", callback_data="adm:banlist"),
             InlineKeyboardButton(text="👥 Subs", callback_data="adm:subs")],
            [InlineKeyboardButton(text=f"🆘 Tickets ({ot})", callback_data="adm:tickets")],
            [InlineKeyboardButton(text="📈 Analytics", callback_data="adm:analytics")]])
        await send_with_buttons(cid, f"🔐 🟢{alive}/{total}|👥{subs}|🆘{ot}", kb)


# ============================
# REPLY → КОММЕНТАРИИ
# ============================

@dp.message(F.reply_to_message)
async def handle_reply_comments(message: Message):
    uid = message.from_user.id
    cid = message.chat.id
    lang = db.get_user_lang(uid)

    if db.is_banned(uid): return
    replied = message.reply_to_message
    if not replied: return
    bot_info = await bot.get_me()
    if not replied.from_user or replied.from_user.id != bot_info.id: return

    replied_text = replied.text or replied.caption or ""
    post_match = re.match(r"^(?:📷|🎥)?\s*<?b?>?(\d+)\.", replied_text)
    if not post_match:
        post_match = re.match(r"^(\d+)\.", replied_text)

    if not post_match:
        raw = (message.text or "").strip()
        num_match = re.match(r"^(\d+)$", raw)
        if num_match:
            post_num = int(num_match.group(1))
        else:
            return
    else:
        post_num = int(post_match.group(1))

    post_index = post_num - 1
    username = last_requested_username.get(cid)
    if not username:
        await message.answer("❌ Send a username first."); return

    has_access, note, limit_type = check_access(uid)
    if not has_access:
        db.log_event(uid, "free_exhausted", limit_type)
        kb = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text=get_text('subscribe_btn', lang), callback_data="sub:choose")]])
        await send_with_buttons(cid, note, kb); return

    allowed, reason = db.check_rate_limit(uid)
    if not allowed: await message.answer(f"⏳ {reason}"); return

    alive = sum(1 for a in manager.accounts if a.is_alive)
    if alive == 0: await message.answer(get_text('no_accounts', lang)); return

    search_msg = await bot.send_message(cid, f"💬 ...")
    db.log_event(uid, "comments", f"{username}/{post_num}")

    try:
        db.log_request(uid, f"{username}/cmt/{post_num}")
        comments, status, acc = await fetch_comments_rotation(manager, username, post_index, 20)
        try: await search_msg.delete()
        except Exception: pass

        if status == "all_dead":
            await bot.send_message(cid, get_text('all_dead', lang)); return
        if status in ("user_not_found", "post_not_found"):
            await bot.send_message(cid, "❌ Post not found."); return
        if not comments:
            await bot.send_message(cid, "😔 No comments."); return

        if not db.has_subscription(uid) and not is_admin(uid):
            db.log_event(uid, "free_request", f"cmt:{username}/{post_num}")

        cache_key = f"{username}_cmt_{post_index}"
        db.set_cache(cache_key, "comments", 0,
                     [{"text": c["text"], "author": c["author"]} for c in comments])

        total = len(comments); show = comments[:5]; has_more = total > 5
        await bot.send_message(cid, f"💬 <b>@{username}</b> ({total})")
        for i, c in enumerate(show, 1):
            await bot.send_message(cid, f"<b>{i}. {c['author'] or '—'}</b>\n{c['text'][:1000]}")
            await asyncio.sleep(0.3)

        kb_rows = []
        if has_more:
            kb_rows.append([InlineKeyboardButton(
                text=f"➡️ {get_text('more', lang)} ({6}–{min(10,total)})",
                callback_data=f"cmt:{username}:{post_index}:1")])
        if kb_rows:
            await send_with_buttons(cid, f"✅ 1–{len(show)} {get_text('of', lang)} {total}",
                                    InlineKeyboardMarkup(inline_keyboard=kb_rows))
        else:
            await bot.send_message(cid, f"✅ {get_text('all', lang)} {total}.")

        if acc: acc.posts_sent += len(show)
        manager.save_stats()
    except Exception as e:
        import traceback; print(f"[ERROR]\n{traceback.format_exc()}")
        await alert_admins(f"Bot error:\n{str(e)[:500]}")
        try: await search_msg.delete()
        except Exception: pass
        await bot.send_message(cid, f"❌ <code>{str(e)[:300]}</code>")


@dp.callback_query(F.data.regexp(r"^cmt:[\w.]+:\d+:\d+$"))
async def handle_comments_page(cb: CallbackQuery):
    parts = cb.data.split(":")
    username, post_index, page_num = parts[1], int(parts[2]), int(parts[3])
    await cb.answer(); cid = cb.message.chat.id
    lang = db.get_user_lang(cb.from_user.id)
    try: await cb.message.edit_reply_markup(reply_markup=None)
    except Exception: pass
    cache_key = f"{username}_cmt_{post_index}"
    comments = db.get_cache(cache_key, "comments", 0)
    if not comments:
        await bot.send_message(cid, "⏳ Cache expired."); return
    start = page_num * 5; end = start + 5
    show = comments[start:end]; total = len(comments); has_more = total > end
    if not show: await bot.send_message(cid, get_text('no_more', lang)); return
    for i, c in enumerate(show, start + 1):
        await bot.send_message(cid, f"<b>{i}. {c['author'] or '—'}</b>\n{c['text'][:1000]}")
        await asyncio.sleep(0.3)
    kb_rows = []
    if has_more:
        kb_rows.append([InlineKeyboardButton(
            text=f"➡️ {get_text('more', lang)} ({end+1}–{min(end+5,total)})",
            callback_data=f"cmt:{username}:{post_index}:{page_num+1}")])
    shown = start + len(show)
    if kb_rows:
        await send_with_buttons(cid, f"✅ {start+1}–{shown} {get_text('of', lang)} {total}",
                                InlineKeyboardMarkup(inline_keyboard=kb_rows))
    else:
        await bot.send_message(cid, f"✅ {get_text('all', lang)} {total}.")


# ============================
# БЫСТРЫЙ ОТВЕТ АДМИНА
# ============================

@dp.message(F.text.regexp(r"^\d+\s+.+"))
async def admin_quick_reply(message: Message):
    uid = message.from_user.id
    if not is_admin(uid): return
    if uid in admin_replying: return

    match = re.match(r"^(\d+)\s+(.+)$", message.text.strip(), re.DOTALL)
    tid = int(match.group(1))
    answer_text = match.group(2).strip()
    if not answer_text: return

    ticket = db.get_ticket(tid)
    if not ticket:
        await message.answer("❌ Ticket not found."); return
    status = ticket["status"] if "status" in ticket.keys() else "open"
    if status != "open":
        await message.answer("❌ Ticket already closed."); return

    db.answer_ticket(tid, answer_text)
    try:
        await bot.send_message(ticket["user_id"], f"💬 <b>Reply to #{tid}</b>\n\n{answer_text}")
    except Exception: pass
    await message.answer(f"✅ Reply to #{tid} sent.")


# ============================
# ОБРАБОТЧИК USERNAME
# ============================

@dp.message(F.text)
async def handle_username(message: Message):
    username = message.text.strip().lstrip("@")
    if username.startswith("/"): return

    uid = message.from_user.id
    lang = db.get_user_lang(uid)
    if db.is_banned(uid): await message.answer("🚫"); return
    if not username.replace(".", "").replace("_", "").isalnum() or len(username) < 2:
        await message.answer(get_text('invalid_username', lang)); return

    has_access, note, limit_type = check_access(uid)
    if not has_access:
        db.log_event(uid, "free_exhausted", limit_type)
        kb = InlineKeyboardMarkup(inline_keyboard=[[
            InlineKeyboardButton(text=get_text('subscribe_btn', lang), callback_data="sub:choose")]])
        await send_with_buttons(message.chat.id,
            f"{note}\n\n<b>{get_text('subscribe_unlocks', lang)}</b>", kb)
        return

    allowed, reason = db.check_rate_limit(uid)
    if not allowed: await message.answer(f"⏳ {reason}"); return

    alive = sum(1 for a in manager.accounts if a.is_alive)
    if alive == 0:
        await alert_admins("Все аккаунты мертвы!")
        await message.answer(get_text('no_accounts', lang)); return

    kb = InlineKeyboardMarkup(inline_keyboard=[[
        InlineKeyboardButton(text=get_text('text_btn', lang), callback_data=f"text:{username}:0"),
        InlineKeyboardButton(text=get_text('screens_btn', lang), callback_data=f"img:{username}:0")]])
    extra = f"\n{note}" if note else ""
    await send_with_buttons(message.chat.id,
        f"🔍 <b>@{username}</b> — {get_text('format', lang)}:{extra}", kb)


@dp.callback_query(F.data.regexp(r"^(text|img):[\w.]+:\d+$"))
async def handle_choice(cb: CallbackQuery):
    parts = cb.data.split(":")
    mode, username, page_num = parts[0], parts[1], int(parts[2])
    await cb.answer()
    cid = cb.message.chat.id
    uid = cb.from_user.id
    lang = db.get_user_lang(uid)

    if db.is_banned(uid): await cb.message.edit_text("🚫"); return

    if page_num == 0:
        has_access, _, _ = check_access(uid)
        if not has_access:
            kb = InlineKeyboardMarkup(inline_keyboard=[[
                InlineKeyboardButton(text=get_text('subscribe_btn', lang), callback_data="sub:choose")]])
            await send_with_buttons(cid, "🔒", kb); return
        allowed, reason = db.check_rate_limit(uid)
        if not allowed: await cb.message.edit_text(f"⏳ {reason}"); return

    try: await cb.message.edit_reply_markup(reply_markup=None)
    except Exception: pass
    if cid in last_button_message: del last_button_message[cid]

    search_msg = await bot.send_message(cid, f"⏳ @{username}...")

    try:
        cached = db.get_cache(username, mode, 0)
        aname = "cache"
        if cached:
            result, status = cached, "ok"
        else:
            if page_num == 0:
                db.log_request(uid, username)
                db.log_event(uid, "search", username)
            result, status, acc = await fetch_with_rotation(manager, username, mode, 20)
            if acc: aname = acc.name
            if result and status == "ok":
                if mode == "text":
                    db.set_cache(username, mode, 0, result)
                if page_num == 0 and not db.has_subscription(uid) and not is_admin(uid):
                    db.log_event(uid, "free_request", username)

        try: await search_msg.delete()
        except Exception: pass

        if status == "all_dead":
            await bot.send_message(cid, get_text('all_dead', lang)); return
        if status == "user_not_found":
            await bot.send_message(cid, get_text('user_not_found', lang, username=username)); return
        if not result or status == "no_posts":
            await bot.send_message(cid, get_text('no_posts', lang)); return

        last_requested_username[cid] = username
        start = page_num * 5; end = start + 5
        cur = result[start:end]; has_more = len(result) > end
        if not cur: await bot.send_message(cid, get_text('no_more', lang)); return

        if page_num == 0:
            await bot.send_message(cid, get_text('posts_found', lang, username=username, count=len(result)))

        if mode == "text":
            for i, item in enumerate(cur, start + 1):
                if isinstance(item, dict):
                    text = item.get("text", "")
                    has_img = item.get("has_image", False)
                    has_vid = item.get("has_video", False)
                    indicators = ""
                    if has_img and has_vid:
                        indicators = f" (📷🎥 {get_text('photo', lang)}+{get_text('video', lang)})"
                    elif has_img:
                        indicators = f" (📷 {get_text('photo', lang)})"
                    elif has_vid:
                        indicators = f" (🎥 {get_text('video', lang)})"
                    msg_text = f"<b>{i}.</b> {text[:4000]}{indicators}"
                else:
                    msg_text = f"<b>{i}.</b> {item[:4000]}"
                await bot.send_message(cid, msg_text)
                await asyncio.sleep(0.3)
        elif mode == "img":
            for i, pd in enumerate(cur, start + 1):
                if isinstance(pd, dict) and "image" in pd:
                    img_data = pd["image"]
                    caption = pd.get("text", "")[:200]
                else:
                    img_data = pd
                    caption = str(i)
                f = BufferedInputFile(img_data, f"p{i}.png")
                await bot.send_photo(cid, photo=f, caption=f"{i}. {caption}")
                await asyncio.sleep(0.3)

        if aname != "cache":
            for a in manager.accounts:
                if a.name == aname:
                    a.posts_sent += len(cur); break

        kb_rows = []
        if has_more:
            kb_rows.append([InlineKeyboardButton(
                text=f"➡️ {get_text('more', lang)} ({end+1}–{min(end+5,len(result))})",
                callback_data=f"{mode}:{username}:{page_num+1}")])
        kb_rows.append([InlineKeyboardButton(
            text=get_text('screens_btn', lang) if mode == "text" else get_text('text_btn', lang),
            callback_data=f"{'img' if mode=='text' else 'text'}:{username}:0")])

        shown = start + len(cur)
        await send_with_buttons(cid,
            f"✅ <b>{start+1}–{shown} {get_text('of', lang)} {len(result)}</b>\n"
            f"{get_text('more_available', lang) if has_more else '📭 ' + get_text('all', lang)}\n"
            f"{get_text('reply_for_comments', lang)}\n"
            f"{get_text('send_other', lang)}",
            InlineKeyboardMarkup(inline_keyboard=kb_rows))
        manager.save_stats()
    except Exception as e:
        import traceback; print(f"[ERROR]\n{traceback.format_exc()}")
        await alert_admins(f"Bot error:\n{str(e)[:500]}")
        try: await search_msg.delete()
        except Exception: pass
        await bot.send_message(cid, f"❌ <code>{str(e)[:300]}</code>")


# ============================
# ПЕРИОДИКА + ЗАПУСК
# ============================

async def periodic_cleanup():
    global fetch_semaphore
    while True:
        await asyncio.sleep(3600)
        db.cleanup_old_logs(); db.clear_expired_cache()
        dead = [a for a in manager.accounts if not a.is_alive]
        if dead:
            print(f"[AUTO] {len(dead)}...")
            recovered = 0
            for acc in dead:
                try:
                    ok = await acc.health_check(manager.playwright)
                    if ok: recovered += 1
                    await asyncio.sleep(5)
                except Exception as e:
                    print(f"  ❌ {acc.name}: {e}")
            if recovered > 0:
                alive = sum(1 for a in manager.accounts if a.is_alive)
                fetch_semaphore = asyncio.Semaphore(max(1, alive))


async def main():
    global fetch_semaphore
    print("🚀 Старт...")
    await manager.start_all()
    alive = sum(1 for a in manager.accounts if a.is_alive)
    if alive == 0:
        print("❌ Нет аккаунтов!")
        await alert_admins("Бот запущен, но все аккаунты мертвы!")
    else:
        fetch_semaphore = asyncio.Semaphore(alive)
        print(f"🔒 Семафор: {alive}")

    asyncio.create_task(periodic_cleanup())
    asyncio.create_task(daily_report())

    while True:
        try:
            print("🔄 Polling...")
            await dp.start_polling(
                bot, polling_timeout=30,
                allowed_updates=["message", "callback_query", "pre_checkout_query"])
        except Exception as e:
            print(f"⚠️ {e}")
            await alert_admins(f"Бот упал:\n{str(e)[:500]}")
            await asyncio.sleep(5)


if __name__ == "__main__":
    asyncio.run(main())