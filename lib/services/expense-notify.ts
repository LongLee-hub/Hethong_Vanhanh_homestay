// Nhắc chủ nhà duyệt chi phí qua nhóm chat Lark.
// Mỗi NĐT có thể đặt webhook bot của nhóm chat có chủ nhà (Kết nối Dayladau → Sửa thông tin NĐT);
// chưa đặt thì gửi vào nhóm Lark chung (cài đặt larkWebhookUrl, cũng là nhóm nhận cảnh báo).
// Chi phí chung (không thuộc NĐT nào) luôn gửi nhóm chung để Admin duyệt.
import { eq, inArray } from "drizzle-orm";
import type { DB } from "../db";
import { expenseCategories, expenses, investors, properties, users } from "../db/schema";
import { getSetting, postLark, type LarkSender } from "./settings";

const vnd = (n: number) => n.toLocaleString("vi-VN") + " ₫";
const dmy = (d: string) => d.split("-").reverse().join("/");

export interface NotifyResult {
  sent: number; // số tin đã gửi
  skipped: number; // số khoản không có nhóm nào để gửi
  failed?: number; // số tin gửi lỗi (webhook sai, mạng)
}

/** Webhook Lark hợp lệ: chỉ nhận địa chỉ bot của Lark/Feishu để không gửi dữ liệu chi phí ra nơi khác. */
export function isLarkWebhook(url: string): boolean {
  try {
    const u = new URL(url);
    return u.protocol === "https:" && /(^|\.)(larksuite\.com|feishu\.cn|larkoffice\.com)$/.test(u.hostname) && u.pathname.includes("/bot/");
  } catch {
    return false;
  }
}

/**
 * Gửi tin nhắc duyệt cho các khoản chi đang chờ. Gom theo nhóm chat: 1 tin / nhóm.
 * `baseUrl`: địa chỉ web app (vd https://app.loci.vn) để dựng link duyệt.
 */
export async function notifyPendingExpenses(db: DB, ids: string[], baseUrl: string, opts: { resubmit?: boolean; send?: LarkSender } = {}): Promise<NotifyResult> {
  const send = opts.send ?? postLark;
  if (!ids.length) return { sent: 0, skipped: 0 };
  const rows = await db
    .select({
      id: expenses.id, propertyId: expenses.propertyId, amount: expenses.amount, description: expenses.description, incurredOn: expenses.incurredOn,
      month: expenses.month, approvalStatus: expenses.approvalStatus, category: expenseCategories.name, createdBy: users.name,
    })
    .from(expenses)
    .innerJoin(expenseCategories, eq(expenseCategories.id, expenses.categoryId))
    .leftJoin(users, eq(users.id, expenses.createdById))
    .where(inArray(expenses.id, ids));
  const pending = rows.filter((r) => r.approvalStatus === "PENDING");
  if (!pending.length) return { sent: 0, skipped: 0 };

  const pids = [...new Set(pending.map((r) => r.propertyId).filter((x): x is string => !!x))];
  const props = pids.length
    ? await db
        .select({ id: properties.id, name: properties.name, investorName: investors.name, webhook: investors.larkWebhookUrl })
        .from(properties)
        .innerJoin(investors, eq(investors.id, properties.investorId))
        .where(inArray(properties.id, pids))
    : [];
  const propOf = new Map(props.map((p) => [p.id, p]));
  const common = await getSetting(db, "larkWebhookUrl");

  // Gom theo webhook đích
  const groups = new Map<string, { title: string; items: typeof pending }>();
  let skipped = 0;
  for (const r of pending) {
    const p = r.propertyId ? propOf.get(r.propertyId) : undefined;
    const own = p?.webhook && isLarkWebhook(p.webhook) ? p.webhook : "";
    const url = own || common;
    if (!url) {
      skipped++;
      continue;
    }
    const who = p ? (own ? p.investorName : `${p.investorName} (gửi nhóm chung — chưa đặt nhóm Lark riêng)`) : "Admin LOCI — chi phí chung";
    const g = groups.get(url) ?? { title: who, items: [] };
    g.items.push(r);
    groups.set(url, g);
  }

  const base = baseUrl.replace(/\/+$/, "");
  let sent = 0;
  let failed = 0;
  for (const [url, g] of groups) {
    const total = g.items.reduce((s, r) => s + r.amount, 0);
    const lines = g.items.slice(0, 15).map((r) => {
      const place = r.propertyId ? propOf.get(r.propertyId)?.name ?? "" : "Chi phí chung";
      return `• **${vnd(r.amount)}** · ${place} · ${r.category} · ${r.description} (${dmy(r.incurredOn)})`;
    });
    if (g.items.length > 15) lines.push(`… và ${g.items.length - 15} khoản khác`);
    const single = g.items.length === 1;
    const link = single ? `${base}/expenses/${g.items[0].id}` : `${base}/expenses/pending`;
    const head = opts.resubmit ? "Kế toán đã sửa lại, xin duyệt lại" : "Kế toán vừa kê khai";
    const by = [...new Set(g.items.map((r) => r.createdBy).filter(Boolean))].join(", ");
    const ok = await send(url, {
      msg_type: "interactive",
      card: {
        config: { wide_screen_mode: true },
        header: { template: "orange", title: { tag: "plain_text", content: `Chi phí chờ duyệt: ${vnd(total)}` } },
        elements: [
          { tag: "div", text: { tag: "lark_md", content: `**${g.title}**\n${head} ${g.items.length} khoản${by ? ` (${by})` : ""}. Chi phí chỉ được ghi nhận sau khi chủ đầu tư duyệt và xác nhận đã chi.` } },
          { tag: "div", text: { tag: "lark_md", content: lines.join("\n") } },
          {
            tag: "action",
            actions: [{ tag: "button", type: "primary", text: { tag: "plain_text", content: single ? "Mở trang duyệt" : `Duyệt ${g.items.length} khoản` }, url: link }],
          },
          { tag: "note", elements: [{ tag: "plain_text", content: link }] },
        ],
      },
    });
    if (ok === false) failed++;
    else sent++;
  }
  return failed ? { sent, skipped, failed } : { sent, skipped };
}
