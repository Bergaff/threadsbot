// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { collectRepliesByTimeLinks } from "../src/threads";

/** page.evaluate(fn, arg) исполняем прямо в happy-dom */
const fakePage: any = { evaluate: async (fn: (a: any) => any, arg: any) => fn(arg) };

const reply = (user: string, code: string, date: string, text: string) => `
  <div class="r">
    <div><a href="/@${user}"><img alt="${user}'s profile picture" src="https://cdn/${user}.jpg"></a></div>
    <div>
      <a href="/@${user}"><span dir="auto">${user}</span></a>
      <a href="/@${user}/post/${code}"><time datetime="2026-05-15">${date}</time></a>
      <span dir="auto">${text}</span>
      <div><span dir="auto">Like</span><span dir="auto">12</span><span dir="auto">Reply</span></div>
    </div>
  </div>`;

describe("комментарии по ссылкам-датам (DOM без data-pressable-container)", () => {
  it("пост недоступен («Post not available»): берёт все ответы на странице", async () => {
    document.body.innerHTML = `
      <div>Thread <span>875 views</span></div>
      <div><span dir="auto">Post not available</span></div>
      ${reply("vadymdoroshenko", "R1", "05/15/26", "😘❤️‍🔥")}
      ${reply("sokolovskii9411", "R2", "05/16/26", "Привет ты такая сексуальная женщина")}`;
    const out = await collectRepliesByTimeLinks(fakePage, "DYXLbEiFhoB");
    expect(out.map((c) => [c.author, c.text])).toEqual([
      ["@vadymdoroshenko", "😘❤️‍🔥"],
      ["@sokolovskii9411", "Привет ты такая сексуальная женщина"],
    ]);
    expect(out[0].avatar).toBe("https://cdn/vadymdoroshenko.jpg");
  });

  it("пост доступен: сам пост и цепочка над ним не считаются комментариями", async () => {
    document.body.innerHTML = `
      ${reply("alice", "PARENT", "05/10/26", "Исходный пост, на который отвечают")}
      ${reply("alina.kuzina", "MAIN", "05/11/26", "Сам пост автора")}
      ${reply("bob", "R1", "05/12/26", "Первый комментарий")}
      ${reply("carol", "R2", "05/12/26", "Второй комментарий")}`;
    const out = await collectRepliesByTimeLinks(fakePage, "MAIN");
    expect(out.map((c) => c.author)).toEqual(["@bob", "@carol"]);
    expect(out[0].text).toBe("Первый комментарий");
  });

  it("служебные подписи, даты и счётчики текстом комментария не становятся", async () => {
    document.body.innerHTML = reply("dave", "R9", "2d", "Like");
    expect(await collectRepliesByTimeLinks(fakePage, "MAIN")).toEqual([]);
  });
});
