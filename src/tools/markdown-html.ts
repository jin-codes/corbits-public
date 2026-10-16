/**
 * A small, dependency-free Markdown to HTML converter for the documents an owner attaches to a task
 * (`browser.paste_document`). It handles the subset such documents use: headings, paragraphs, bullet and
 * numbered lists, rules, **bold**, *italic*, `code` and [links](https://...). Everything else stays
 * literal text. All text is HTML-escaped first, and a link only keeps an http(s) address, so the output
 * can carry no markup the document did not ask for.
 */

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function inline(raw: string): string {
  let s = escapeHtml(raw);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  // Link text may itself contain emphasis, so the address is cut out first and only http(s) is kept.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, text: string, url: string) => `<a href="${url}">${text}</a>`);
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, "$1<em>$2</em>");
  return s;
}

export function markdownToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: "ul" | "ol"; items: string[] } | null = null;

  const flushPara = () => {
    if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
    list = null;
  };

  for (const line of lines) {
    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    const bullet = /^\s*[-*]\s+(.+?)\s*$/.exec(line);
    const numbered = /^\s*\d+\.\s+(.+?)\s*$/.exec(line);
    if (!line.trim()) {
      flushPara();
      flushList();
    } else if (/^\s*---+\s*$/.test(line)) {
      flushPara();
      flushList();
      out.push("<hr>");
    } else if (heading) {
      flushPara();
      flushList();
      const level = heading[1]!.length;
      out.push(`<h${level}>${inline(heading[2]!)}</h${level}>`);
    } else if (bullet || numbered) {
      flushPara();
      const tag = bullet ? "ul" : "ol";
      if (list && list.tag !== tag) flushList();
      list ??= { tag, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return out.join("");
}

/** The same document as plain text (the clipboard's text/plain flavour): markup marks removed, structure kept. */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/\r\n?/g, "\n")
    .replace(/^#{1,3}\s+/gm, "")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "$1 ($2)")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*(?!\*)/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1");
}
