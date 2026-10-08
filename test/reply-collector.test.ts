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
