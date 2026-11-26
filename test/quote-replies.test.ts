import { describe, expect, it } from "vitest";
import { FeedCollector, ReplyCollector, mergeDomWithFeed, normalizeQuoteOnly, type FeedPost } from "../src/threadsFeed";
import { expectedOf } from "../src/threads";

/**
 * pr101: пост-цитата. Реальный случай из дампа comments-DfmIfyeEZ4a-0of71.json:
 * @sashameat_tattoo процитировала пост @bileav.me (71 ответ), у самой цитаты ответов 0 («No replies yet»),
 * а бот/сайт ждали 71 и слали админу «собрано 0 из ~71».
 */
function quotePost(code: string, user: string, ownText: string, ownReplies: number, quoted: { code: string; user: string; text: string; replies: number }) {
  return {
    code,
    pk: code + "_pk",
    user: { username: user, profile_pic_url: `https://cdn.example/${user}.jpg` },
    caption: ownText ? { text: ownText } : null,
    taken_at: 1762800000,
    like_count: 1,
    text_post_app_info: {
      reply_to_author: null,
      direct_reply_count: ownReplies,
      share_info: {
        quoted_post: {
          code: quoted.code,
          pk: quoted.code + "_pk",
          user: { username: quoted.user },
          caption: { text: quoted.text },
          taken_at: 1762600000,
          like_count: 343,
          text_post_app_info: { reply_to_author: null, direct_reply_count: quoted.replies },
        },
      },
    },
  };
}

const QUOTE = quotePost("DfmIfyeEZ4a", "sashameat_tattoo", "", 0, { code: "DfiaWUegBQg", user: "bileav.me", text: "ищу мужа.", replies: 71 });

describe("pr101: счётчик ответов у постов-цитат", () => {
  it("страница поста: берётся счётчик самого поста, а не цитируемого", () => {
    const rc = new ReplyCollector("DfmIfyeEZ4a", "sashameat_tattoo");
    rc.ingestJson({ data: { media: QUOTE } }, true);
    expect(rc.mainReplyCount).toBe(0);
    expect(expectedOf(rc, 71)).toBe(0);
    // Нет данных о самом посте - остаётся число из ленты
    expect(expectedOf(new ReplyCollector("X"), 71)).toBe(71);
  });

  it("цитата с собственным текстом: счётчик самого поста (2), а не цитаты (58)", () => {
    const own = quotePost("DftzYkOkXNF", "margarita.kostya", "и винтажную дубленку", 2, { code: "DftlKFUEbAJ", user: "margarita.kostya", text: "Я Рита мне скоро 34", replies: 58 });
    const rc = new ReplyCollector("DftzYkOkXNF", "margarita.kostya");
    rc.ingestJson({ data: { media: own } }, true);
    expect(rc.mainReplyCount).toBe(2);
  });

  it("лента: цитата без своего текста больше не выпадает, ответы - самого поста", () => {
    const p = normalizeQuoteOnly(QUOTE)!;
    expect(p.id).toBe("DfmIfyeEZ4a");
    expect(p.replies).toBe("0");
    expect(p.likes).toBe("1");
    expect(p.author).toBe("sashameat_tattoo");
    expect(p.text).toBe("↪ @bileav.me: ищу мужа.");
    const f = new FeedCollector("sashameat_tattoo");
    f.ingestJson({ data: { mediaData: { edges: [{ node: { thread_items: [{ post: QUOTE }] } }], page_info: { has_next_page: false } } } });
    expect(f.posts.map((x) => [x.id, x.replies])).toEqual([["DfmIfyeEZ4a", "0"]]);
  });

  it("объединение DOM и сети: счётчики из сети важнее DOM (DOM видел цифры цитаты)", () => {
    const dom: FeedPost[] = [{ id: "", text: "ищу мужа.", has_image: false, has_video: false, postUrl: "/@sashameat_tattoo/post/DfmIfyeEZ4a", likes: "343", replies: "71" }];
    const net = [normalizeQuoteOnly(QUOTE)!];
    const [m] = mergeDomWithFeed(dom, net);
    expect(m.replies).toBe("0");
    expect(m.likes).toBe("1");
    expect(m.text).toBe("ищу мужа.");
    // Если в сети счётчика нет - остаётся DOM
    const [m2] = mergeDomWithFeed(dom, [{ ...net[0], replies: undefined, likes: undefined }]);
    expect(m2.replies).toBe("71");
  });
});
