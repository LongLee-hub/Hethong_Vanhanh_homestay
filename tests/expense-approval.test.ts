// Luồng kê khai → chủ đầu tư duyệt → ghi nhận; Admin sửa/xóa; nhắc duyệt qua Lark; ghi nhận từ sao kê. Chạy trên PGlite với migration thật.
import { beforeAll, describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import * as schema from "../lib/db/schema";
import type { DB } from "../lib/db";
import type { SessionUser } from "../lib/auth/access";
import {
  approveExpenses, createExpense, deleteExpense, expenseDetail, pendingExpenses, rejectExpenses, setCommonFinalized, updateExpense,
} from "../lib/services/expenses";
import { getSettlement, lockSettlement } from "../lib/services/settlement";
import { isLarkWebhook, notifyPendingExpenses } from "../lib/services/expense-notify";
import { importStatement, recordTransactions, setTransactionsIgnored, statementTransactions } from "../lib/services/bank-statements";
import { parseStatementGrid, type Cell } from "../lib/bank/statement-parser";
import { saveInvestor } from "../lib/dayladau/admin";
import { updateProperty } from "../lib/services/properties";

let db: DB;
const admin: SessionUser = { id: "u-admin", name: "Admin", role: "ADMIN" };
const invA: SessionUser = { id: "u-inv-a", name: "NĐT A", role: "INVESTOR" };
const invB: SessionUser = { id: "u-inv-b", name: "NĐT B", role: "INVESTOR" };
const acc: SessionUser = { id: "u-acc", name: "Kế toán", role: "ACCOUNTANT" };
const HOOK_A = "https://open.larksuite.com/open-apis/bot/v2/hook/aaaa";
const HOOK_COMMON = "https://open.larksuite.com/open-apis/bot/v2/hook/common";

beforeAll(async () => {
  const pg = new PGlite();
  for (const file of readdirSync(new URL("../drizzle/", import.meta.url)).filter((f) => f.endsWith(".sql")).sort()) {
    const sql = readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8");
    for (const stmt of sql.split("--> statement-breakpoint")) if (stmt.trim()) await pg.exec(stmt);
  }
  db = drizzle(pg, { schema }) as unknown as DB;
  const s = schema;
  await db.insert(s.users).values([
    { id: admin.id, name: admin.name, role: "ADMIN", passwordHash: "x" },
    { id: invA.id, name: invA.name, role: "INVESTOR", passwordHash: "x" },
    { id: invB.id, name: invB.name, role: "INVESTOR", passwordHash: "x" },
    { id: acc.id, name: acc.name, role: "ACCOUNTANT", passwordHash: "x" },
  ]);
  await db.insert(s.investors).values([
    { id: "inv-a", name: "NĐT A", userId: invA.id, larkWebhookUrl: HOOK_A },
    { id: "inv-b", name: "NĐT B", userId: invB.id },
  ]);
  await db.insert(s.properties).values([
    { id: "X", investorId: "inv-a", name: "Vạn Phúc", bankCodes: ["vp"] },
    { id: "Z", investorId: "inv-b", name: "Khương Trung", bankCodes: ["kt"] },
  ]);
  await db.insert(s.rooms).values([
    { id: "X1", propertyId: "X", name: "P101", openedOn: "2026-01-01" },
    { id: "Z1", propertyId: "Z", name: "P101", openedOn: "2026-01-01" },
  ]);
  await db.insert(s.userPropertyAccess).values([{ userId: acc.id, propertyId: "X" }, { userId: acc.id, propertyId: "Z" }]);
  await db.insert(s.expenseCategories).values([
    { id: "supplies", name: "Vật tư tiêu hao", scope: "DIRECT" },
    { id: "salary", name: "Lương", scope: "COMMON" },
  ]);
  await db.insert(s.settings).values({ key: "larkWebhookUrl", value: HOOK_COMMON });
});

const base = { categoryId: "supplies", month: "2026-10", incurredOn: "2026-10-05" };

describe("Kê khai → duyệt → ghi nhận", () => {
  it("kế toán kê khai: chờ duyệt, chưa tính vào quyết toán", async () => {
    const e = await createExpense(db, acc, { ...base, propertyId: "X", amount: 1_000_000, description: "Nước giặt" });
    expect(e).toMatchObject({ approvalStatus: "PENDING", paymentStatus: "UNPAID" });
    expect((await getSettlement(db, invA, "inv-a", "2026-10")).lines[0].directCost).toBe(0);
    expect((await pendingExpenses(db, invA)).map((x) => x.id)).toContain(e.id);
    expect(await pendingExpenses(db, invB)).toEqual([]);
  });

  it("NĐT khác không duyệt được; kế toán không tự duyệt", async () => {
    const [e] = await pendingExpenses(db, invA);
    await expect(approveExpenses(db, invB, [e.id])).rejects.toMatchObject({ status: 404 });
    await expect(approveExpenses(db, acc, [e.id])).rejects.toMatchObject({ status: 403 });
  });

  it("chủ đầu tư duyệt → đã chi, ghi nhận vào quyết toán", async () => {
    const [e] = await pendingExpenses(db, invA);
    expect((await expenseDetail(db, invA, e.id)).canApprove).toBe(true);
    await approveExpenses(db, invA, [e.id]);
    const d = await expenseDetail(db, invA, e.id);
    expect(d).toMatchObject({ approvalStatus: "APPROVED", paymentStatus: "PAID", approvedById: invA.id, canApprove: false });
    expect((await getSettlement(db, invA, "inv-a", "2026-10")).lines[0].directCost).toBe(1_000_000);
    await expect(approveExpenses(db, invA, [e.id])).rejects.toThrow(/đã được duyệt/);
  });

  it("từ chối phải có lý do; kế toán sửa lại → chờ duyệt lại", async () => {
    const e = await createExpense(db, acc, { ...base, propertyId: "X", amount: 500_000, description: "Dầu gội" });
    await expect(rejectExpenses(db, invA, [e.id], " ")).rejects.toThrow(/lý do/);
    await rejectExpenses(db, invA, [e.id], "Sai số tiền");
    expect((await expenseDetail(db, acc, e.id)).rejectReason).toBe("Sai số tiền");
    const u = await updateExpense(db, acc, e.id, { amount: 450_000 });
    expect(u).toMatchObject({ approvalStatus: "PENDING", rejectReason: null, resubmitted: true, amount: 450_000 });
  });

  it("chi phí chung: chỉ Admin duyệt; Admin tự kê khai thì ghi nhận luôn", async () => {
    const c = await createExpense(db, acc, { ...base, categoryId: "salary", propertyId: null, amount: 3_000_000, description: "Lương kế toán" });
    await expect(approveExpenses(db, invA, [c.id])).rejects.toThrow(/Admin duyệt/);
    await expect(setCommonFinalized(db, acc, "2026-10", true)).rejects.toThrow(/chưa được duyệt/);
    await approveExpenses(db, admin, [c.id]);
    const c2 = await createExpense(db, admin, { ...base, categoryId: "salary", propertyId: null, amount: 1_000_000, description: "Phần mềm" });
    expect(c2.approvalStatus).toBe("APPROVED");
  });
});

describe("Sửa / xóa", () => {
  it("kế toán không sửa xóa được khoản đã duyệt, Admin thì được", async () => {
    const e = await createExpense(db, acc, { ...base, propertyId: "Z", amount: 200_000, description: "Ổ cắm" });
    await approveExpenses(db, invB, [e.id]);
    await expect(updateExpense(db, acc, e.id, { amount: 1 })).rejects.toThrow(/chỉ Admin/);
    await expect(deleteExpense(db, acc, e.id)).rejects.toThrow(/chỉ Admin/);
    const u = await updateExpense(db, admin, e.id, { amount: 250_000, description: "Ổ cắm điện" });
    expect(u).toMatchObject({ amount: 250_000, approvalStatus: "APPROVED", updatedById: admin.id, resubmitted: false });
    await deleteExpense(db, admin, e.id);
    await expect(expenseDetail(db, admin, e.id)).rejects.toMatchObject({ status: 404 });
  });

  it("đổi khoản đã duyệt sang cơ sở NĐT khác → phải duyệt lại", async () => {
    const e = await createExpense(db, acc, { ...base, propertyId: "Z", amount: 300_000, description: "Bóng đèn" });
    await approveExpenses(db, invB, [e.id]);
    const u = await updateExpense(db, admin, e.id, { propertyId: "X" });
    expect(u.approvalStatus).toBe("PENDING");
  });

  it("kế toán sửa xóa khoản chưa duyệt", async () => {
    const e = await createExpense(db, acc, { ...base, propertyId: "X", amount: 100_000, description: "Tạm" });
    await updateExpense(db, acc, e.id, { description: "Tạm 2" });
    await deleteExpense(db, acc, e.id);
  });

  it("tháng đã khóa sổ: không duyệt / sửa được kể cả Admin", async () => {
    const e = await createExpense(db, acc, { ...base, month: "2026-09", incurredOn: "2026-09-30", propertyId: "Z", amount: 100_000, description: "Cuối tháng 9" });
    await setCommonFinalized(db, admin, "2026-09", true);
    await lockSettlement(db, admin, "inv-b", "2026-09");
    await expect(approveExpenses(db, invB, [e.id])).rejects.toThrow(/khóa sổ/);
    await expect(updateExpense(db, admin, e.id, { amount: 1 })).rejects.toThrow(/khóa sổ/);
  });
});

describe("Nhắc duyệt qua Lark", () => {
  it("gửi nhóm của NĐT kèm link duyệt; NĐT chưa có nhóm riêng → nhóm chung", async () => {
    const a = await createExpense(db, acc, { ...base, propertyId: "X", amount: 120_000, description: "Vòi hoa sen" });
    const b = await createExpense(db, acc, { ...base, propertyId: "Z", amount: 80_000, description: "Khăn" });
    const calls: { url: string; body: any }[] = [];
    const r = await notifyPendingExpenses(db, [a.id, b.id], "https://app.loci.vn/", { send: async (url, body) => void calls.push({ url, body }) });
    expect(r).toEqual({ sent: 2, skipped: 0 });
    const toA = calls.find((c) => c.url === HOOK_A)!;
    const text = JSON.stringify(toA.body);
    expect(text).toContain(`https://app.loci.vn/expenses/${a.id}`);
    expect(text).toContain("Vòi hoa sen");
    expect(text).not.toContain("Khăn"); // khoản của NĐT B không lọt vào nhóm NĐT A
    expect(calls.find((c) => c.url === HOOK_COMMON)).toBeTruthy();
  });

  it("chỉ nhận webhook Lark thật", async () => {
    expect(isLarkWebhook(HOOK_A)).toBe(true);
    expect(isLarkWebhook("https://evil.example.com/open-apis/bot/v2/hook/x")).toBe(false);
    expect(isLarkWebhook("http://open.larksuite.com/open-apis/bot/v2/hook/x")).toBe(false);
    const emptyInfo = { phone: null, email: null, taxCode: null, address: null, bankName: null, bankAccountNo: null, bankAccountName: null, managementFeePct: null, contractStartOn: null, contractEndOn: null, contractUrl: null, payoutDay: null, active: true, note: null };
    await expect(saveInvestor(db, admin, { id: "inv-b", name: "NĐT B", ...emptyInfo, larkWebhookUrl: "https://example.com/x" })).rejects.toThrow(/Webhook Lark/);
    await saveInvestor(db, admin, { id: "inv-b", name: "NĐT B", ...emptyInfo, larkWebhookUrl: "https://open.feishu.cn/open-apis/bot/v2/hook/b" });
    // Không truyền webhook (form khác) → giữ nguyên
    await saveInvestor(db, admin, { id: "inv-b", name: "NĐT B", ...emptyInfo });
    const [b] = await db.select().from(schema.investors).where(eq(schema.investors.id, "inv-b"));
    expect(b.larkWebhookUrl).toBe("https://open.feishu.cn/open-apis/bot/v2/hook/b");
  });
});

describe("Sao kê ngân hàng", () => {
  const head: Cell[][] = [
    [null, null, "SAO KÊ CHI TIẾT TÀI KHOẢN", null, null, null, null, "NGÂN HÀNG TMCP QUÂN ĐỘI"],
    [null, null, "Từ ngày/From:01/10/2026 00:00:00 Đến ngày/To:31/10/2026 23:59:59"],
    ["Tên khách hàng/Customer name: CONG TY MAU", null, null, null, null, null, null, "Tài khoản/Account No: 9999"],
    ["STT", "NGÀY GIAO DỊCH", "NGÀY HẠCH TOÁN", "PHÁT SINH NỢ", "PHÁT SINH CÓ", "SỐ DƯ", "ĐƠN VỊ THỤ HƯỞNG/ĐƠN VỊ CHUYỂN", "NỘI DUNG", "BÚT TOÁN"],
  ];
  const rows: Cell[][] = [
    ["1", "15/10/2026 11:07:44", "15/10/2026", 403000, 0, 1, "LO THI A", "khd-vp-nuoc giat", "FT1"],
    ["2", "14/10/2026 07:06:11", "14/10/2026", 0, 10000000, 1, "CONG TY MAU", "Chuyen khoan van hanh", "FT2"],
    ["3", "05/10/2026 10:52:48", "05/10/2026", 12000000, 0, 1, "BUI C", "kt-luong don dep t9", "FT3"],
    ["4", "06/10/2026 10:52:48", "06/10/2026", 5000000, 0, 1, "TRAN D", "chuyen nham", "FT4"],
  ];

  it("tải lên: tiền vào bỏ qua, tải lại không nhân đôi", async () => {
    const p = parseStatementGrid([...head, ...rows]);
    p.accountNo = "88889999";
    await expect(importStatement(db, invA, "sk.xlsx", p)).rejects.toMatchObject({ status: 403 });
    const r1 = await importStatement(db, acc, "sk.xlsx", p);
    expect(r1).toMatchObject({ added: 4, duplicates: 0, outflows: 3 });
    const r2 = await importStatement(db, acc, "sk-lai.xlsx", p);
    expect(r2).toMatchObject({ added: 0, duplicates: 4, statementId: null });
  });

  it("gợi ý theo mã cơ sở, ghi nhận → chi phí chờ duyệt, đã chi", async () => {
    const list = await statementTransactions(db, acc, null);
    expect(list.map((t) => t.ref).sort()).toEqual(["FT1", "FT3", "FT4"]);
    const ft1 = list.find((t) => t.ref === "FT1")!;
    const ft3 = list.find((t) => t.ref === "FT3")!;
    expect(ft1.suggestion).toMatchObject({ propertyId: "X", categoryId: "supplies", month: "2026-10" });
    expect(ft3.suggestion).toMatchObject({ propertyId: "Z", categoryId: "salary", month: "2026-09" });

    const res = await recordTransactions(db, acc, [
      { txnId: ft1.id, propertyId: "X", categoryId: "supplies", month: "2026-10", description: ft1.suggestion!.description },
      { txnId: ft3.id, propertyId: "Z", categoryId: "salary", month: "2026-09", description: "Lương dọn dẹp t9" }, // tháng 9 NĐT B đã khóa
    ]);
    expect(res.created).toHaveLength(1);
    expect(res.errors[0]).toMatchObject({ txnId: ft3.id });
    expect(res.errors[0].message).toMatch(/khóa sổ/);
    const e = await expenseDetail(db, acc, res.created[0]);
    expect(e).toMatchObject({ amount: 403_000, approvalStatus: "PENDING", paymentStatus: "PAID", incurredOn: "2026-10-15", bankTransactionId: ft1.id });

    // Dòng lỗi vẫn chưa phân loại; dòng đã ghi nhận không ghi nhận lại được
    const again = await recordTransactions(db, acc, [{ txnId: ft1.id, propertyId: "X", categoryId: "supplies", month: "2026-10", description: "x" }]);
    expect(again.errors[0].message).toMatch(/đã được xử lý/);
    expect((await statementTransactions(db, acc, null)).map((t) => t.ref).sort()).toEqual(["FT3", "FT4"]);

    // Xóa chi phí → dòng sao kê trở lại chưa phân loại
    await deleteExpense(db, acc, e.id);
    expect((await statementTransactions(db, acc, null)).map((t) => t.ref).sort()).toEqual(["FT1", "FT3", "FT4"]);
  });

  it("đánh dấu không phải chi phí", async () => {
    const ft4 = (await statementTransactions(db, acc, null)).find((t) => t.ref === "FT4")!;
    expect(await setTransactionsIgnored(db, acc, [ft4.id], true, "Chuyển nhầm, đã hoàn")).toBe(1);
    expect((await statementTransactions(db, acc, null)).some((t) => t.ref === "FT4")).toBe(false);
    expect(await setTransactionsIgnored(db, acc, [ft4.id], false)).toBe(1);
  });

  it("học cơ sở theo mã khách hàng hóa đơn điện", async () => {
    const p = parseStatementGrid([
      ...head,
      ["1", "08/10/2026 17:11:20", "08/10/2026", 8615376, 0, 1, "VNPAY", "VNPAY BILL ELECTRIC 1446341185 aWyI f17B2EY.BP1", "FT10"],
      ["2", "08/11/2026 17:11:20", "08/11/2026", 7000000, 0, 1, "VNPAY", "VNPAY BILL ELECTRIC 1446341185 zzzz", "FT11"],
    ]);
    p.accountNo = "88889999";
    await importStatement(db, acc, "dien.xlsx", p);
    const t10 = (await statementTransactions(db, acc, null)).find((t) => t.ref === "FT10")!;
    expect(t10.suggestion!.propertyId).toBeUndefined();
    await recordTransactions(db, acc, [{ txnId: t10.id, propertyId: "X", categoryId: "supplies", month: "2026-10", description: "Tiền điện" }]);
    const t11 = (await statementTransactions(db, acc, null)).find((t) => t.ref === "FT11")!;
    expect(t11.suggestion!.propertyId).toBe("X");
  });

  it("mã cơ sở trùng nhau bị chặn", async () => {
    const input = { name: "Khương Trung", address: null, investmentAmount: 0, investmentStartMonth: null, occupancyKpiPct: 70, variableCostPerNight: 0, fixedCostMonthly: 0 };
    await expect(updateProperty(db, admin, "Z", { ...input, bankCodes: ["VP"] })).rejects.toThrow(/đã dùng cho Vạn Phúc/);
    const r = await updateProperty(db, admin, "Z", { ...input, bankCodes: ["KT", " kt2 "] });
    expect(r.bankCodes).toEqual(["kt", "kt2"]);
  });
});
