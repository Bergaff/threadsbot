import json
import time
from pathlib import Path
from playwright.sync_api import sync_playwright

# Теперь используем куки от threads.net
COOKIES_FILE = Path("threads_cookies.json")

def convert_cookies(cookies_list):
    out = []
    for c in cookies_list:
        same_site = c.get("sameSite", "Lax")
        if same_site in ("unspecified", None, ""):
            same_site = "Lax"
        elif same_site == "no_restriction":
            same_site = "None"
        elif same_site == "lax":
            same_site = "Lax"
        elif same_site == "strict":
            same_site = "Strict"

        cookie = {
            "name": c["name"],
            "value": c["value"],
            "domain": c["domain"],
            "path": c.get("path", "/"),
            "httpOnly": bool(c.get("httpOnly", False)),
            "secure": bool(c.get("secure", True)),
            "sameSite": same_site,
        }
        if "expirationDate" in c and isinstance(c["expirationDate"], (int, float)):
            cookie["expires"] = float(c["expirationDate"])
        out.append(cookie)
    return out

def main():
    cookies_list = json.loads(COOKIES_FILE.read_text(encoding="utf-8"))
    cookies = convert_cookies(cookies_list)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=False)
        context = browser.new_context(
            user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        )

        page = context.new_page()

        # Открываем threads.net
        page.goto("https://www.threads.net/", wait_until="domcontentloaded")
        time.sleep(2)

        # Ставим куки от threads.net
        context.add_cookies(cookies)
        print("Куки от threads.net установлены!")

        # Перезагружаем
        page.reload(wait_until="domcontentloaded")
        time.sleep(3)

        print(f"URL: {page.url}")

        # Проверяем залогинены ли мы
        # Если залогинены - в URL не будет /login
        if "/login" not in page.url:
            print("✅ Похоже что мы залогинены!")
        else:
            print("❌ Нас перекинуло на логин")

        # Идём на конкретного пользователя
        target = "zuck"
        print(f"\nОткрываем @{target}...")
        page.goto(f"https://www.threads.net/@{target}", wait_until="domcontentloaded")
        time.sleep(4)

        # Читаем посты
        texts = page.locator("div[data-pressable-container] span").all_text_contents()
        texts = [t.strip() for t in texts if len(t.strip()) > 20]

        # Убираем дубли
        seen = set()
        unique_texts = []
        for t in texts:
            if t not in seen:
                seen.add(t)
                unique_texts.append(t)

        print(f"\nНайдено уникальных постов: {len(unique_texts)}")
        for i, t in enumerate(unique_texts[:5], 1):
            print(f"\n--- Пост {i} ---")
            print(t[:300])

        input("\nНажми Enter чтобы закрыть...")
        browser.close()

if __name__ == "__main__":
    main()