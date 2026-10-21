// Đọc thư Gmail qua REST API (gmail.readonly). Tách phần thân thư thành văn bản thuần để bộ tách payout xử lý.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailMessage {
  id: string;
  receivedAt: Date;
  from: string;
  subject: string;
  /** Thân thư dạng văn bản thuần: ưu tiên phần text/plain, không có thì bỏ thẻ phần text/html. */
  text: string;
}

export interface GmailClient {
  listMessageIds(accessToken: string, query: string, max: number): Promise<string[]>;
  getMessage(accessToken: string, id: string): Promise<GmailMessage>;
}

async function get(accessToken: string, url: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Gmail API ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json() as Promise<any>;
}

interface Part {
  mimeType?: string;
  body?: { data?: string };
  parts?: Part[];
}

function collect(p: Part, out: { plain: string[]; html: string[] }) {
  const data = p.body?.data ? Buffer.from(p.body.data, "base64url").toString("utf8") : "";
  if (data && p.mimeType === "text/plain") out.plain.push(data);
  else if (data && p.mimeType === "text/html") out.html.push(data);
  for (const c of p.parts ?? []) collect(c, out);
}

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘" };

/** HTML → văn bản: mỗi khối/ô bảng thành một dòng, giải mã thực thể HTML, gộp khoảng trắng. */
export function htmlToText(html: string): string {
  return html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|td|th|li|h[1-6]|table|section)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .split("\n")
    .map((l) => l.replace(/[ \t ​]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

export function messageText(payload: Part): string {
  const out = { plain: [] as string[], html: [] as string[] };
  collect(payload, out);
  // Email Airbnb có cả hai phần; bản HTML giữ cấu trúc bảng tốt hơn bản text (bản text hay dồn nhiều cột vào một dòng)
  if (out.html.length) return htmlToText(out.html.join("\n"));
  return out.plain.join("\n").replace(/\r/g, "");
}

export const httpGmailClient: GmailClient = {
  async listMessageIds(accessToken, query, max) {
    const ids: string[] = [];
    let pageToken = "";
    while (ids.length < max) {
      const p = new URLSearchParams({ q: query, maxResults: String(Math.min(100, max - ids.length)) });
      if (pageToken) p.set("pageToken", pageToken);
      const r = await get(accessToken, `${API}/messages?${p}`);
      for (const m of r.messages ?? []) ids.push(String(m.id));
      if (!r.nextPageToken) break;
      pageToken = r.nextPageToken;
    }
    return ids;
  },
  async getMessage(accessToken, id) {
    const m = await get(accessToken, `${API}/messages/${encodeURIComponent(id)}?format=full`);
    const headers: { name: string; value: string }[] = m.payload?.headers ?? [];
    const h = (n: string) => headers.find((x) => x.name.toLowerCase() === n)?.value ?? "";
    return { id: String(m.id), receivedAt: new Date(Number(m.internalDate)), from: h("from"), subject: h("subject"), text: messageText(m.payload ?? {}) };
  },
};
