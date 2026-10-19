import { describe, expect, it } from "vitest";
import { buildPaginationBody, describeReplayFailure, graphqlFriendlyName, replaySummary, templateFromRequest, newReplayStats } from "../src/feedReplay";
import { FeedCollector } from "../src/threadsFeed";
import { attachFeedCollector, replayNextPage } from "../src/threads";

const USER = "sercanby_";
const post = (code: string, user = USER) => ({
  pk: code + "pk", code, user: { username: user, profile_pic_url: "" }, caption: { text: `text of ${code}` },
  taken_at: 1727800000, like_count: 1, text_post_app_info: { direct_reply_count: 0 }, image_versions2: { candidates: [] },
});
const feedPage = (codes: string[], cursor: string | null, user = USER) => JSON.stringify({
  data: { mediaData: { edges: codes.map((c) => ({ node: { thread_items: [{ post: post(c, user) }] } })), page_info: { has_next_page: Boolean(cursor), end_cursor: cursor } } },
});
const formBody = (vars: Record<string, unknown>, extra: Record<string, string> = {}) =>
  new URLSearchParams({ av: "17841", lsd: "LSDTOKEN", fb_api_req_friendly_name: "BarcelonaProfileThreadsTabRefetchableDirectQuery", doc_id: "9876543210", variables: JSON.stringify(vars), ...extra }).toString();
const HEADERS = { "content-type": "application/x-www-form-urlencoded", "x-fb-lsd": "LSDTOKEN", "x-ig-app-id": "238260118697367", cookie: "sessionid=SECRET", "user-agent": "UA", "sec-fetch-site": "same-origin" };

describe("templateFromRequest", () => {
  it("captures doc_id, cursor key 'after' and only safe headers (no cookie/user-agent/sec-*)", () => {
    const { template, reason } = templateFromRequest("https://www.threads.com/graphql/query", HEADERS, formBody({ after: "C1", first: 10, userID: "42" }));
    expect(reason).toBe("ok");
    expect(template!.docId).toBe("9876543210");
    expect(template!.cursorKey).toBe("after");
    expect(template!.friendlyName).toBe("BarcelonaProfileThreadsTabRefetchableDirectQuery");
    expect(template!.headers).toEqual({ "content-type": "application/x-www-form-urlencoded", "x-fb-lsd": "LSDTOKEN", "x-ig-app-id": "238260118697367" });
  });
  it("finds a non-standard cursor variable by a cursor we already saw", () => {
    const { template } = templateFromRequest("/graphql/query", {}, formBody({ cursor: "SEEN", first: 10 }), ["SEEN"]);
    expect(template!.cursorKey).toBe("cursor");
  });
  it("explains why a request is not usable", () => {
    expect(templateFromRequest("/g", {}, null).reason).toBe("запрос без тела");
    expect(templateFromRequest("/g", {}, "variables=%7B%7D").reason).toBe("нет doc_id");
    expect(templateFromRequest("/g", {}, "doc_id=1&variables=oops").reason).toContain("variables не JSON");
    expect(templateFromRequest("/g", {}, formBody({ first: 10, userID: "42" })).reason).toContain("нет курсора (ключи: first,userID)");
  });
});

describe("buildPaginationBody / friendly name / failures", () => {
  it("replaces only the cursor, keeps tokens and other variables", () => {
    const { template } = templateFromRequest("/graphql/query", HEADERS, formBody({ after: "C1", first: 10, userID: "42" }));
    const p = new URLSearchParams(buildPaginationBody(template!, "C2")!);
    expect(JSON.parse(p.get("variables")!)).toEqual({ after: "C2", first: 10, userID: "42" });
    expect(p.get("lsd")).toBe("LSDTOKEN");
    expect(p.get("doc_id")).toBe("9876543210");
  });
  it("friendly name from header, body or doc_id", () => {
    expect(graphqlFriendlyName({ "x-fb-friendly-name": "Q1" }, null)).toBe("Q1");
    expect(graphqlFriendlyName({}, "fb_api_req_friendly_name=Q2&doc_id=1")).toBe("Q2");
    expect(graphqlFriendlyName({}, "doc_id=77")).toBe("doc_id=77");
    expect(graphqlFriendlyName({}, null)).toBe("?");
  });
  it("describes GraphQL errors, login pages and HTTP codes", () => {
    expect(describeReplayFailure(200, 'for (;;);{"errors":[{"message":"Document not found","code":1675002}]}')).toBe("Document not found (код 1675002)");
    expect(describeReplayFailure(200, "<html><body>Log in</body></html>")).toContain("HTML-страница");
    expect(describeReplayFailure(429, "")).toBe("HTTP 429");
    expect(describeReplayFailure(200, '{"data":{}}')).toBe("ответ без постов автора");
  });
  it("summary lists seen queries when no template was captured", () => {
    const s = replaySummary(null, newReplayStats(), "", { BarcelonaProfileRootQuery: 2, useBarcelonaFooQuery: 1 });
    expect(s).toContain("шаблон не пойман");
    expect(s).toContain("BarcelonaProfileRootQuery×2");
  });
});

describe("FeedCollector cursor tracking", () => {
  it("records cursors and page_info updates only for the author's feed", () => {
    const f = new FeedCollector(USER);
    f.ingestText(feedPage(["A1"], "C1"));
    f.ingestText(feedPage(["Z1"], "OTHER", "someone_else"));
    f.ingestText(feedPage(["A2"], "C2"));
    expect(f.cursors).toEqual(["C1", "C2"]);
    expect(f.pageInfoUpdates).toBe(2);
    expect(f.endCursor).toBe("C2");
  });
});

/** Имитация страницы playwright: on("response"), evaluate(fn, arg) с серверной лентой из 3 порций */
function fakePage(serverPages: Record<string, { status?: number; text: string }>) {
  const handlers: Array<(r: any) => void> = [];
  const fetched: string[] = [];
  const page: any = {
    on: (ev: string, h: any) => { if (ev === "response") handlers.push(h); },
    evaluate: async (_fn: any, arg: any) => {
      const vars = JSON.parse(new URLSearchParams(arg.body).get("variables")!);
      fetched.push(vars.after);
      // Страница видит и свой fetch - перехватчик должен его пропустить
      emit(arg.path, arg.headers, arg.body, serverPages[vars.after]?.text || "{}");
      const r = serverPages[vars.after];
      return r ? { status: r.status ?? 200, text: r.text } : { status: 200, text: "{}" };
    },
  };
  const emit = (url: string, headers: any, body: string | null, text: string) => {
    for (const h of handlers) h({ url: () => url, headers: () => ({ "content-type": "application/json" }), request: () => ({ postData: () => body, headers: () => headers }), text: async () => text });
  };
  return { page, emit, fetched };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("capture -> replay in the page", () => {
  it("captures the scroll-triggered feed request and fetches next pages with the new cursor", async () => {
    const { page, emit, fetched } = fakePage({
      C2: { text: feedPage(["P21", "P22"], "C3") },
      C3: { text: feedPage(["P31"], null) },
    });
    const feed = attachFeedCollector(page, USER);
    feed.ingestText(feedPage(["P01", "P02"], "C1")); // встроенный в HTML JSON
    // Прокрутка вызвала запрос страницы after=C1 -> ответ с лентой автора
    emit("https://www.threads.com/graphql/query", HEADERS, formBody({ after: "C1", first: 10 }), feedPage(["P11", "P12"], "C2"));
    emit("https://www.threads.com/graphql/query", { "x-fb-friendly-name": "BarcelonaNotificationsQuery" }, "doc_id=5&variables=%7B%7D", "{}");
    await flush();
    expect(feed.template?.docId).toBe("9876543210");
    expect(feed.queriesSeen).toEqual({ BarcelonaProfileThreadsTabRefetchableDirectQuery: 1, BarcelonaNotificationsQuery: 1 });

    expect(await replayNextPage(page, feed)).toBe(2);
    expect(await replayNextPage(page, feed)).toBe(1);
    expect(feed.hasNextPage).toBe(false);
    expect(await replayNextPage(page, feed)).toBe(-1); // лента кончилась - повторять нечего
    expect(fetched).toEqual(["C2", "C3"]);
    expect(feed.posts.map((p) => p.id)).toEqual(["P01", "P02", "P11", "P12", "P21", "P22", "P31"]);
    expect(feed.replay).toMatchObject({ attempts: 2, ok: 2, added: 3, disabled: false });
    expect(feed.queriesSeen.BarcelonaProfileThreadsTabRefetchableDirectQuery).toBe(1); // свои повторы не считаются
    expect(replaySummary(feed.template, feed.replay, feed.captureNote, feed.queriesSeen)).toContain("повторов 2, успешных 2, +3 постов");
  });

  it("on a GraphQL error disables replay (scroll takes over) and logs the reason", async () => {
    const { page, emit } = fakePage({ C2: { text: '{"errors":[{"message":"Document not found"}]}' } });
    const feed = attachFeedCollector(page, USER);
    emit("/graphql/query", HEADERS, formBody({ after: "C1" }), feedPage(["P11"], "C2"));
    await flush();
    expect(await replayNextPage(page, feed)).toBe(0);
    expect(feed.replay.disabled).toBe(true);
    expect(feed.replay.errors[0]).toContain("Document not found");
    expect(feed.replay.errors[0]).toContain("курсор не сдвинулся");
    expect(await replayNextPage(page, feed)).toBe(-1);
  });

  it("no template when the page never requested the author's feed: note is kept for the log", async () => {
    const { page, emit } = fakePage({});
    const feed = attachFeedCollector(page, USER);
    emit("/graphql/query", HEADERS, formBody({ first: 10 }), feedPage(["P11"], "C2"));
    await flush();
    expect(feed.template).toBeNull();
    expect(feed.captureNote).toContain("нет курсора");
    expect(await replayNextPage(page, feed)).toBe(-1);
  });
});
