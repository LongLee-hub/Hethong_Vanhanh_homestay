// Đọc thư Gmail qua REST API (gmail.readonly). Tách phần thân thư thành văn bản thuần để bộ tách payout xử lý.

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

export interface GmailMessage {
  id: string;
  receivedAt: Date;
  from: string;
  subject: string;
  /** Thân thư dạng văn bản thuần: phần text/plain, không có thì bỏ thẻ phần text/html. */
  text: string;
}

export interface GmailClient {
  listMessageIds(accessToken: string, query: string, max: number): Promise<string[]>;
  getMessage(accessToken: string, id: string): Promise<GmailMessage>;
}

/**
 * Lỗi Gmail API → câu tiếng Việt nói rõ cách sửa. Google trả JSON dạng
 * { error: { code, message, errors: [{ reason }], details: [{ reason, metadata: { consumer: "projects/123" } }] } }.
 */
export function gmailErrorMessage(status: number, body: string): string {
  let err: { message?: string; status?: string; errors?: { reason?: string }[]; details?: { reason?: string; metadata?: Record<string, string> }[] } = {};
  try {
    err = JSON.parse(body)?.error ?? {};
  } catch {
    /* không phải JSON */
  }
  const reasons = [err.status, ...(err.errors ?? []).map((e) => e.reason), ...(err.details ?? []).map((d) => d.reason)].filter(Boolean).join(" ");
  const msg = err.message ?? body;
  if (status === 403 && /SERVICE_DISABLED|accessNotConfigured/i.test(reasons + " " + msg) || /has not been used in project|is disabled/i.test(msg)) {
    const project = (err.details ?? []).map((d) => d.metadata?.consumer?.match(/projects\/(\d+)/)?.[1]).find(Boolean) ?? msg.match(/project (\d+)/)?.[1];
    const link = `https://console.cloud.google.com/apis/library/gmail.googleapis.com${project ? `?project=${project}` : ""}`;
    return `Gmail API chưa được bật${project ? ` cho project Google Cloud ${project}` : ""}. Mở ${link}, bấm Enable, đợi 2–5 phút rồi bấm "Đọc thư ngay" (không cần kết nối lại).`;
  }
  if (status === 403 && /insufficientPermissions|SCOPE_INSUFFICIENT|insufficient.*scope/i.test(reasons + " " + msg)) {
    return 'Chưa cấp quyền đọc Gmail. Bấm "Thêm Gmail" để kết nối lại và tích ô cho phép xem email ở màn hình Google.';
  }
  if (status === 401) return "Phiên đăng nhập Google hết hạn hoặc bị thu hồi, cần kết nối lại Gmail.";
  if (status === 429 || /rateLimit|RESOURCE_EXHAUSTED/i.test(reasons)) return "Gmail đang giới hạn số lần đọc, thử lại sau vài phút.";
  return `Gmail API lỗi ${status}: ${String(msg).replace(/\s+/g, " ").slice(0, 200)}`;
}

async function get(accessToken: string, url: string) {
  const res = await fetch(url, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(gmailErrorMessage(res.status, await res.text().catch(() => "")));
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
  // Bộ tách đọc bản text/plain giống msg.getPlainBody() của Apps Script (tên khách và số tiền cách nhau ≥ 2 dấu cách);
  // chỉ khi email không có phần text mới đổi HTML ra chữ
  if (out.plain.length) return out.plain.join("\n").replace(/\r/g, "");
  return htmlToText(out.html.join("\n"));
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
