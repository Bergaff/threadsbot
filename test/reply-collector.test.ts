import { describe, expect, it } from "vitest";
import { ReplyCollector } from "../src/threadsFeed";

function post(code: string, user: string, text: string, replyTo: string | null, extra: Record<string, unknown> = {}) {
  return {
    code,
    pk: code + "_pk",
    user: { username: user, profile_pic_url: `https://cdn.example/${user}.jpg` },
    caption: { text },
    taken_at: 1759900000,
    like_count: 3,
    text_post_app_info: { reply_to_author: replyTo ? { username: replyTo } : null, direct_reply_count: 0, ...extra },
  };
}

/** Структура страницы поста /@user/post/CODE: цепочка поста + ветки ответов + рекомендации */
function postPage() {
  return {
    data: {
      data: {
        edges: [
          // Цепочка: предок (пост, на который отвечает main) -> сам пост
          { node: { thread_items: [{ post: post("ANCESTOR1", "alice", "Исходный пост", null) }, { post: post("MAIN1", "alina.kuzina", "Пост-ответ автора", "alice")}] } },
          // Ветки ответов
          { node: { thread_items: [{ post: post("R1", "bob", "Первый коммент", "alina.kuzina") }] } },
          { node: { thread_items: [{ post: post("R2", "carol", "Второй коммент", "alina.kuzina") }, { post: post("R2a", "alina.kuzina", "Ответ автора Кэрол", "carol") }] } },
          // Рекомендация «ещё посты» - верхний уровень, не комментарий
          { node: { thread_items: [{ post: post("REC1", "stranger", "Рекомендованный пост", null) }] } },
          // Недоступный ответ
          { node: { thread_items: [{ post: post("GONE", "dave", "удалён", "alina.kuzina", { is_post_unavailable: true }) }] } },
        ],
      },
    },
  };
}

describe("ReplyCollector (комментарии из JSON страницы поста)", () => {
  it("собирает ответы, исключая сам пост, предков, рекомендации и недоступные", () => {
    const rc = new ReplyCollector("MAIN1");
    const added = rc.ingestJson(postPage());
    expect(rc.mainSeen).toBe(true);
    expect(added).toBe(3);
    expect(rc.replies.map((r) => r.code)).toEqual(["R1", "R2", "R2a"]);
    expect(rc.replies[0]).toMatchObject({ author: "@bob", text: "Первый коммент", likes: "3" });
  });

  it("дедуплицирует повторы из предзагрузки и GraphQL", () => {
    const rc = new ReplyCollector("MAIN1");
    rc.ingestJson(postPage());
    const more = { data: { edges: [{ node: { thread_items: [{ post: post("R1", "bob", "Первый коммент", "alina.kuzina") }, { post: post("R3", "eve", "Новый после прокрутки", "alina.kuzina") }] } }] } };
    expect(rc.ingestJson(more)).toBe(1);
    expect(rc.replies.map((r) => r.code)).toEqual(["R1", "R2", "R2a", "R3"]);
    expect(rc.responses).toBe(2);
  });

  it("предок, пришедший раньше цепочки поста, удаляется из ответов", () => {
    const rc = new ReplyCollector("MAIN1");
    rc.ingestJson({ edges: [{ node: { thread_items: [{ post: post("ANCESTOR1", "alice", "Исходный пост", "zed") }] } }] });
    expect(rc.replies.map((r) => r.code)).toEqual(["ANCESTOR1"]);
    rc.ingestJson(postPage());
    expect(rc.replies.map((r) => r.code)).not.toContain("ANCESTOR1");
  });

  it("понимает тело ответа с префиксом for (;;); и медиа без текста", () => {
    const rc = new ReplyCollector("MAIN1");
    const photo = { ...post("P1", "frank", "", "alina.kuzina"), image_versions2: { candidates: [{ url: "https://cdn.example/p.jpg", width: 640, height: 640 }] } };
    const body = "for (;;);" + JSON.stringify({ data: { edges: [{ node: { thread_items: [{ post: photo }] } }] } });
    expect(rc.ingestText(body)).toBe(1);
    expect(rc.replies[0]).toMatchObject({ code: "P1", author: "@frank", text: "📷" });
  });

  it("без поста на странице берёт только ответы (reply_to_author задан)", () => {
    const rc = new ReplyCollector("OTHER");
    rc.ingestJson(postPage());
    expect(rc.mainSeen).toBe(false);
    expect(rc.replies.map((r) => r.code)).toEqual(["MAIN1", "R1", "R2", "R2a"]);
  });

  it("пост недоступен: ответы без reply_to_author всё равно берутся, посты самого автора - нет", () => {
    const rc = new ReplyCollector("GONE1", "alina.kuzina");
    rc.ingestText(JSON.stringify({ data: { edges: [
      { node: { thread_items: [{ post: { code: "GONE1", text_post_app_info: { is_post_unavailable: true } } }] } },
      { node: { thread_items: [{ post: post("V1", "vadymdoroshenko", "😘❤️‍🔥", null) }] } },
      { node: { thread_items: [{ post: post("S1", "sokolovskii9411", "Привет", null) }] } },
      { node: { thread_items: [{ post: post("A1", "alina.kuzina", "Ещё от автора", null) }] } },
    ] } }));
    expect(rc.replies).toHaveLength(0);
    expect(rc.mainSeen).toBe(false);
    expect(rc.bestReplies.map((r) => r.author)).toEqual(["@vadymdoroshenko", "@sokolovskii9411"]);
    expect(rc.stats()).toContain("с кодом поста 1");
    expect(rc.stats()).toContain("отброшено «не ответ» 3");
  });

  it("пост виден: рекомендации без reply_to_author в итог не попадают", () => {
    const rc = new ReplyCollector("MAIN1", "alina.kuzina");
    rc.ingestJson(postPage());
    expect(rc.bestReplies.map((r) => r.code)).toEqual(["R1", "R2", "R2a"]);
  });
});

describe("ReplyCollector: ответы вне thread_items (запасной путь, pr85)", () => {
  /** Другая форма ответа: replies -> edges -> node -> post, без thread_items и без кода поста */
  const repliesOnly = () => ({
    data: {
      replies: {
        edges: [
          { node: { post: post("X1", "ewa", "Super!", "ewelina_wnuk") } },
          { node: { post: post("X2", "marek", "Zgadzam się", "ewelina_wnuk", { quoted: post("Q1", "other", "cytat", null) }) } },
          { node: { post: post("X3", "ewelina_wnuk", "dzięki", "ewa") } },
          { node: { post: post("TOP", "stranger", "polecany post", null) } },
          { node: { post: post("GONE2", "x", "usunięty", "ewelina_wnuk", { is_post_unavailable: true }) } },
        ],
      },
    },
  });

  it("берёт посты с reply_to_author из любой формы JSON, без рекомендаций и недоступных", () => {
    const rc = new ReplyCollector("MAINPL", "ewelina_wnuk");
    rc.ingestText(JSON.stringify(repliesOnly()));
    expect(rc.replies).toHaveLength(0);
    expect(rc.bestReplies.map((r) => r.code)).toEqual(["X1", "X2", "X3"]);
    expect(rc.stats()).toContain("вне thread_items 3");
    expect(rc.stats()).toContain("пост в JSON нет");
  });

  it("строгий путь (thread_items) важнее запасного и не дублируется в нём", () => {
    const rc = new ReplyCollector("MAIN1", "alina.kuzina");
    rc.ingestJson(postPage());
    expect(rc.loose).toHaveLength(0);
    expect(rc.bestReplies.map((r) => r.code)).toEqual(["R1", "R2", "R2a"]);
  });

  it("сам пост вне thread_items отмечается в диагностике", () => {
    const rc = new ReplyCollector("MAINPL", "ewelina_wnuk");
    rc.ingestJson({ data: { post: post("MAINPL", "ewelina_wnuk", "post", null) } });
    expect(rc.mainSeenAnywhere).toBe(true);
    expect(rc.stats()).toContain("пост в JSON да (вне thread_items)");
  });

  it("в сводке видно, с каких адресов приходили ответы сети", () => {
    const rc = new ReplyCollector("M");
    rc.endpoints["/graphql/query"] = 28;
    rc.endpoints["/api/v1/text_feed/N/replies/"] = 2;
    expect(rc.stats()).toContain("/graphql/query×28, /api/v1/text_feed/N/replies/×2");
  });
});
