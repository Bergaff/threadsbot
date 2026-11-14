import { describe, expect, it } from "vitest";
import { ReplyCollector, postTimeMs, sortPostsNewestFirst } from "../src/threadsFeed";
import { mergePostLists } from "../src/profile";
import { parseCount } from "../src/postCode";
import { isFewComments } from "../src/threads";
import { parseExpectedReplies } from "../src/index";
import { renderProfilePage } from "../src/web";

function post(code: string, user: string, text: string, info: Record<string, unknown> | null) {
  const p: any = { code, pk: code + "_pk", user: { username: user }, caption: { text }, taken_at: 1759900000 };
  if (info) p.text_post_app_info = info;
  return p;
}

describe("сортировка постов от свежего к старому (pr86)", () => {
  it("понимает форматы дат парсеров", () => {
    expect(postTimeMs("2026-09-15 23:01")).toBe(Date.UTC(2026, 8, 15, 23, 1));
    expect(postTimeMs("2026-09-15T23:01:39.000Z")).toBe(Date.UTC(2026, 8, 15, 23, 1, 39));
    expect(postTimeMs(1759900000)).toBe(1759900000000);
    expect(postTimeMs("2h", 10_000_000)).toBe(10_000_000 - 7_200_000);
    expect(postTimeMs("5 дн.", 1e12)).toBe(1e12 - 5 * 86400_000);
    expect(postTimeMs("Sep 15")).toBeNaN();
    expect(postTimeMs("")).toBeNaN();
  });

  it("закреплённый старый пост и посты из сети встают на место по дате", () => {
    const posts = [
      { id: "pinned", date: "2026-09-20 10:00" },
      { id: "hour", date: "2026-10-02 11:00" },
      { id: "nodate" },
      { id: "d3", date: "2026-09-29 12:00" },
      { id: "net-new", date: "2026-10-01 09:00" },
    ];
    expect(sortPostsNewestFirst(posts).map((p) => p.id)).toEqual(["hour", "nodate", "net-new", "d3", "pinned"]);
    expect(posts[0].id).toBe("pinned"); // исходный массив не меняется
  });

  it("без дат порядок сохраняется", () => {
    const posts: Array<{ id: string; date?: string }> = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(sortPostsNewestFirst(posts).map((p) => p.id)).toEqual(["a", "b", "c"]);
  });

  it("«загрузить ещё»: хвост по дате, новее показанных в хвост не ставится", () => {
    const base = [
      { text: "a", postUrl: "/@u/post/AAA", date: "2026-10-02 10:00" },
      { text: "b", postUrl: "/@u/post/BBB", date: "2026-09-30 10:00" },
    ];
    const fresh = [
      { text: "brand new", postUrl: "/@u/post/NEW", date: "2026-10-02 12:00" },
      { text: "a", postUrl: "/@u/post/AAA", date: "2026-10-02 10:00" },
      { text: "old2", postUrl: "/@u/post/OLD2", date: "2026-09-20 10:00" },
      { text: "old1", postUrl: "/@u/post/OLD1", date: "2026-09-25 10:00" },
    ];
    expect(mergePostLists(base, fresh).map((p: any) => p.text)).toEqual(["a", "b", "old1", "old2"]);
  });
});

describe("счётчик ответов и неполный сбор (pr86)", () => {
  it("parseCount", () => {
    expect(parseCount("40")).toBe(40);
    expect(parseCount("1,2K")).toBe(1200);
    expect(parseCount("1,234")).toBe(1234);
    expect(parseCount("3 тыс.")).toBe(3000);
    expect(parseCount("0")).toBe(0);
    expect(parseCount("")).toBe(0);
    expect(parseCount("много")).toBe(1);
  });

  it("parseExpectedReplies: r=N и старый r=1", () => {
    expect(parseExpectedReplies("40")).toBe(40);
    expect(parseExpectedReplies("1")).toBe(1);
    expect(parseExpectedReplies(null)).toBe(0);
    expect(parseExpectedReplies("abc")).toBe(0);
  });

  it("isFewComments: 1 из 40 - мало, 12 из 40 - норма, малые счётчики не трогаем", () => {
    expect(isFewComments(1, 40)).toBe(true);
    expect(isFewComments(9, 40)).toBe(true); // меньше трети от лимита 30
    expect(isFewComments(10, 40)).toBe(false);
    expect(isFewComments(1, 5)).toBe(false);
    expect(isFewComments(1, 1)).toBe(false);
    expect(isFewComments(2, 9)).toBe(true);
    expect(isFewComments(3, 9)).toBe(false);
  });

  it("на странице профиля data-replies - число ответов, клиент разбирает так же", async () => {
    const env: any = { BOT_USERNAME: "threadsreaderbot" };
    const data: any = {
      profile: { username: "u", displayName: "U", bio: "", avatar: "", followers: "1", verified: false },
      posts: [
        { text: "p1", has_image: false, has_video: false, postUrl: "https://www.threads.com/@u/post/AAAAA1", replies: "1,2K" },
        { text: "p2", has_image: false, has_video: false, postUrl: "https://www.threads.com/@u/post/AAAAA2", replies: "40" },
        { text: "p3", has_image: false, has_video: false, postUrl: "https://www.threads.com/@u/post/AAAAA3", replies: "0" },
      ],
    };
    const html = await renderProfilePage(env, "u", data, null, "ru").text();
    expect(html).toContain('data-replies="1200"');
    expect(html).toContain('data-replies="40"');
    expect(html).toContain('data-replies="0"');
    expect(html).toContain("q.push('r=' + expectN)");
    const src = html.match(/function replyCountClient\(v\) \{[\s\S]*?\n    \}/)?.[0];
    expect(src).toBeTruthy();
    const fn = new Function(src + "; return replyCountClient;")();
    expect([fn("40"), fn("1,2K"), fn("1,234"), fn("3 тыс."), fn("0"), fn(""), fn("много")]).toEqual([40, 1200, 1234, 3000, 0, 0, 1]);
  });
});

describe("ReplyCollector: другие формы ответов (pr86)", () => {
  it("reply_to_author в другой форме (без username) - тоже ответ", () => {
    const rc = new ReplyCollector("MAIN", "olesiyaaaa");
    rc.ingestText(JSON.stringify({ data: { post: post("MAIN", "olesiyaaaa", "пост", { reply_to_author: null }), list: [
      post("A1", "x", "коммент 1", { reply_to_author: { id: "123" } }),
      post("A2", "y", "коммент 2", { reply_to_author: { pk: 5, username: "olesiyaaaa" } }),
      post("REC", "z", "рекомендация", { reply_to_author: null }),
    ] } }));
    expect(rc.bestReplies.map((r) => r.code)).toEqual(["A1", "A2"]);
    expect(rc.shape()).toContain("JSON-постов кроме самого 3 (с reply_to_author 2, с null 1");
    expect(rc.shape()).toContain("где: data.list×3");
  });

  it("без поля reply_to_author: берём, только если в том же документе есть сам пост", () => {
    const rc = new ReplyCollector("MAIN", "olesiyaaaa");
    // Чужой документ (рекомендации) без кода поста - не берём
    rc.ingestText(JSON.stringify({ feed: [post("F1", "a", "чужое", { some: 1 })] }));
    expect(rc.bestReplies).toHaveLength(0);
    rc.ingestText(JSON.stringify({ data: { main: post("MAIN", "olesiyaaaa", "пост", { some: 1 }), replies: [post("S1", "b", "ответ", { some: 1 }), post("S2", "c", "ответ 2", null)] } }));
    expect(rc.bestReplies.map((r) => r.code)).toEqual(["S1", "S2"]);
    expect(rc.stats()).toContain("мягко 2");
    expect(rc.shape()).toContain("без поля 2");
    expect(rc.shape()).toContain("без text_post_app_info 1");
  });

  it("строгие ответы важнее мягких", () => {
    const rc = new ReplyCollector("MAIN", "o");
    rc.ingestText(JSON.stringify({ main: post("MAIN", "o", "пост", { some: 1 }), r: [post("S1", "b", "мягкий", { some: 1 }), post("L1", "c", "ответ", { reply_to_author: { username: "o" } })] }));
    expect(rc.bestReplies.map((r) => r.code)).toEqual(["L1"]);
  });

  it("сохраняет самые информативные образцы для файла админу", () => {
    const rc = new ReplyCollector("MAIN");
    rc.ingestText('{"x":1}', "net");
    rc.ingestText(JSON.stringify({ a: post("MAIN", "o", "t", null) }), "html");
    expect(rc.samples).toHaveLength(1);
    expect(rc.samples[0].src).toBe("html");
  });
});

describe("ReplyCollector: мягкий путь не берёт цитаты (pr86)", () => {
  it("пост в quoted_post внутри главного поста - не комментарий", () => {
    const rc = new ReplyCollector("MAIN", "o");
    const main = post("MAIN", "o", "пост", { some: 1, share_info: { quoted_post: post("Q1", "q", "цитата", { some: 1 }) } });
    rc.ingestText(JSON.stringify({ data: { main } }));
    expect(rc.bestReplies).toHaveLength(0);
  });
});
