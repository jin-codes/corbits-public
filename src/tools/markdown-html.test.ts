import { describe, expect, it } from "vitest";
import { inline, markdownToHtml, markdownToText } from "./markdown-html.js";

describe("markdownToHtml", () => {
  it("converts headings, paragraphs, lists, rules and emphasis", () => {
    const html = markdownToHtml("## 제목\n\n본문 **굵게** 와 *기울임*.\n\n- 하나\n- 둘\n\n1. 첫째\n2. 둘째\n\n---\n\n끝");
    expect(html).toBe(
      "<h2>제목</h2><p>본문 <strong>굵게</strong> 와 <em>기울임</em>.</p><ul><li>하나</li><li>둘</li></ul><ol><li>첫째</li><li>둘째</li></ol><hr><p>끝</p>",
    );
  });

  it("turns http(s) links into anchors and leaves other schemes as text", () => {
    expect(inline("[기사](https://a.example/x?y=1&z=2)")).toBe('<a href="https://a.example/x?y=1&amp;z=2">기사</a>');
    expect(inline("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
    expect(inline("[x](data:text/html,hi)")).toBe("[x](data:text/html,hi)");
  });

  it("escapes markup in the document so it cannot add any", () => {
    const html = markdownToHtml('<script>alert(1)</script> & "quote" <img src=x onerror=1>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&amp;");
  });

  it("keeps a source line and the italic header line intact", () => {
    const html = markdownToHtml("*종가 $36.44 · 거래량 평소의 0.6배*\n\n출처: [A](https://a.example/1) · [B](https://b.example/2)");
    expect(html).toContain("<em>종가 $36.44 · 거래량 평소의 0.6배</em>");
    expect(html).toContain('<a href="https://a.example/1">A</a> · <a href="https://b.example/2">B</a>');
  });

  it("joins the lines of one paragraph with a line break", () => {
    expect(markdownToHtml("한 줄\n두 줄")).toBe("<p>한 줄<br>두 줄</p>");
  });

  it("does not mistake a lone asterisk or a multiplication sign for emphasis", () => {
    expect(inline("2 * 3 * 4")).toBe("2 * 3 * 4");
  });
});

describe("markdownToText", () => {
  it("drops the marks but keeps words and addresses", () => {
    expect(markdownToText("## 제목\n\n**굵게** [기사](https://a.example/1)")).toBe("제목\n\n굵게 기사 (https://a.example/1)");
  });
});
