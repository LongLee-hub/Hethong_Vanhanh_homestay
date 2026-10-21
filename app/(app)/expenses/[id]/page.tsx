// Trang một khoản chi: link trong tin nhắn Lark mở thẳng vào đây để chủ nhà duyệt.
import Link from "next/link";
import * as D from "@/lib/domain";
import { getDb } from "@/lib/db";
import { can, HttpError } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { requireUser } from "@/lib/server";
import { categories, visibleProperties } from "@/lib/queries";
import { expenseDetail } from "@/lib/services/expenses";
import { vnd } from "@/components/MonthNav";
import { ActionForm } from "@/components/ActionForm";
import { PhotoInput } from "@/components/PhotoInput";
import { approveAction, deleteExpenseAction, rejectAction, remindAction, updateExpenseAction } from "../actions";
import { ApprovalPill, ExpenseFields, Receipts } from "../shared";

const dt = (d: Date | null) => (d ? d.toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh", dateStyle: "short", timeStyle: "short" }) : "");

export default async function ExpensePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!can(user, "viewFinance")) return <NoAccess />;
  const { id } = await params;
  const db = getDb();
  let e: Awaited<ReturnType<typeof expenseDetail>>;
  try {
    e = await expenseDetail(db, user, id);
  } catch (err) {
    if (err instanceof HttpError && err.status === 404) {
      return (
        <section className="panel" style={{ marginTop: 32 }}>
          <h1>Không tìm thấy khoản chi</h1>
          <p className="muted">Khoản chi đã bị xóa hoặc không thuộc cơ sở của bạn.</p>
          <Link className="btn" href="/expenses/pending">Xem các khoản chờ duyệt</Link>
        </section>
      );
    }
    throw err;
  }
  const [props, cats] = e.canModify ? await Promise.all([visibleProperties(db, user), categories(db)]) : [[], []];
  return (
    <>
      <div className="topbar">
        <h1>{vnd(e.amount)}</h1>
        <ApprovalPill status={e.approvalStatus} />
        <p className="sub">{e.propertyName} · {e.categoryName} · {e.description}</p>
      </div>

      {e.approvalStatus === "APPROVED" && e.approvedAt && <div className="banner info"><span>Đã duyệt và xác nhận đã chi lúc {dt(e.approvedAt)} — chi phí đã được ghi nhận vào {D.formatMonthVN(e.month).toLowerCase()}.</span></div>}
      {e.canApprove && (
        <section className="panel" style={{ marginBottom: 16 }}>
          <header><div><h2>Duyệt khoản chi</h2><p>Bấm duyệt nghĩa là chủ đầu tư đã chi tiền cho khoản này; chi phí được ghi nhận vào {D.formatMonthVN(e.month).toLowerCase()}.</p></div></header>
          <ActionForm action={approveAction} submit="Duyệt & xác nhận đã chi" className="row">
            <input type="hidden" name="ids" value={e.id} />
          </ActionForm>
          <details className="fold" style={{ marginTop: 16 }}>
            <summary className="small">Không đồng ý? Từ chối kèm lý do</summary>
            <ActionForm action={rejectAction} submit="Từ chối" submitClass="btn danger">
              <input type="hidden" name="ids" value={e.id} />
              <label className="field full"><span>Lý do</span><input type="text" name="reason" id="reject-reason" required placeholder="vd: sai số tiền, thiếu hóa đơn" /></label>
            </ActionForm>
          </details>
        </section>
      )}

      {e.approvalStatus === "REJECTED" && <div className="banner bad"><span><b>Bị từ chối:</b> {e.rejectReason} — kế toán sửa lại bên dưới sẽ tự gửi duyệt lại.</span></div>}

      <div className="grid g2">
        <section className="panel">
          <header><h2>Chi tiết</h2><Link className="btn sm" href={`/expenses?month=${e.month}`}>Chi phí {D.formatMonthVN(e.month).toLowerCase()}</Link></header>
          <div className="stack">
            <div className="kv"><span>Cơ sở</span><b>{e.propertyName}</b></div>
            <div className="kv"><span>Loại</span><b>{e.categoryName}</b></div>
            <div className="kv"><span>Số tiền</span><b>{vnd(e.amount)}</b></div>
            <div className="kv"><span>Tháng hạch toán</span><b>{D.formatMonthVN(e.month)}</b></div>
            <div className="kv"><span>Ngày phát sinh</span><b>{D.formatDateVN(e.incurredOn)}</b></div>
            <div className="kv"><span>Mô tả</span><b>{e.description}</b></div>
            <div className="kv"><span>Thanh toán</span><b>{e.paymentStatus === "PAID" ? `Đã chi${e.bankTransactionId ? " (theo sao kê)" : ""}` : "Chưa chi"}</b></div>
            <div className="kv"><span>Kê khai lúc</span><b>{dt(e.createdAt)}</b></div>
            {e.approvedAt && <div className="kv"><span>{e.approvalStatus === "REJECTED" ? "Từ chối lúc" : "Duyệt lúc"}</span><b>{dt(e.approvedAt)}</b></div>}
            {e.updatedAt && <div className="kv"><span>Sửa lần cuối</span><b>{dt(e.updatedAt)}</b></div>}
            <div className="kv"><span>Hóa đơn</span><Receipts urls={e.receiptUrls} /></div>
            {e.bankTxn && (
              <div className="banner info" style={{ margin: 0 }}>
                <span>Sao kê {D.formatDateVN(e.bankTxn.bookedOn)} · bút toán <b>{e.bankTxn.ref}</b><br />{e.bankTxn.counterparty} — {e.bankTxn.content}</span>
              </div>
            )}
          </div>
        </section>

        <div className="stack">
          {e.approvalStatus === "PENDING" && !e.canApprove && (
            <section className="panel">
              <header><div><h2>Đang chờ chủ đầu tư duyệt</h2><p>{e.propertyId ? "Chủ đầu tư nhận tin trong nhóm Lark của cơ sở." : "Chi phí chung do Admin duyệt."}</p></div></header>
              {e.canModify && (
                <ActionForm action={remindAction} submit="Nhắc lại trong nhóm Lark" submitClass="btn" className="row">
                  <input type="hidden" name="ids" value={e.id} />
                </ActionForm>
              )}
            </section>
          )}

          {e.canModify && (
            <section className="panel">
              <header><div><h2>Sửa khoản chi</h2>{e.approvalStatus === "APPROVED" && <p>Khoản đã duyệt: chỉ Admin sửa được, giữ nguyên trạng thái duyệt.</p>}</div></header>
              <ActionForm action={updateExpenseAction} submit={e.approvalStatus === "REJECTED" ? "Lưu và gửi duyệt lại" : "Lưu"} okText="Đã lưu">
                <input type="hidden" name="id" value={e.id} />
                <ExpenseFields props={props} cats={cats} allowCommon={can(user, "declareCommon")} idPrefix={`e-${e.id}`} value={e} />
                <PhotoInput name="receipt" label="Thêm ảnh hóa đơn" />
              </ActionForm>
              <div className="danger-zone">
                <ActionForm action={deleteExpenseAction} submit="Xóa khoản chi" submitClass="btn danger" className="row" confirmText={`Xóa khoản chi ${vnd(e.amount)} "${e.description}"?${e.bankTransactionId ? " Dòng sao kê sẽ trở lại chưa phân loại." : ""}`}>
                  <input type="hidden" name="id" value={e.id} />
                  <input type="hidden" name="back" value={`/expenses?month=${e.month}`} />
                </ActionForm>
              </div>
            </section>
          )}
        </div>
      </div>
    </>
  );
}
