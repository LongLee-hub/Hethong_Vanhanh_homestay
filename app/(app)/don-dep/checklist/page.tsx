// Sửa checklist dọn phòng: thêm, sửa, xoá, đổi thứ tự mục; gắn ảnh mẫu và hướng dẫn cho từng mục.
// Một checklist mặc định cho mọi cơ sở (Admin sửa); cơ sở cần khác thì tạo checklist riêng (Admin hoặc Quản lý cơ sở đó).
import Link from "next/link";
import { getDb } from "@/lib/db";
import { can } from "@/lib/auth/access";
import { NoAccess } from "@/components/NoAccess";
import { ActionForm } from "@/components/ActionForm";
import { PhotoInput } from "@/components/PhotoInput";
import { requireUser } from "@/lib/server";
import { visibleProperties } from "@/lib/queries";
import { photoHref } from "@/lib/storage";
import { canEditDefault, effectiveTemplate, MAX_STEPS, propertiesWithOwnTemplate, type ChecklistStep } from "@/lib/services/checklists";
import { CleanNav } from "../nav";
import { addStepAction, createOwnAction, deleteOwnAction, moveStepAction, removeStepAction, updateStepAction } from "./actions";

const DEFAULT = "mac-dinh";

function StepFields({ s, scope }: { s?: ChecklistStep; scope: string }) {
  return (
    <>
      <input type="hidden" name="propertyId" value={scope} />
      {s && <input type="hidden" name="stepId" value={s.id} />}
      <label className="field full">
        <span>Tên việc</span>
        <input type="text" name="item" required maxLength={160} defaultValue={s?.item} placeholder="Ví dụ: Gấp khăn tắm thành hình thiên nga" />
      </label>
      <label className="field full">
        <span>Hướng dẫn (không bắt buộc)</span>
        <textarea name="hint" maxLength={300} defaultValue={s?.hint ?? ""} placeholder="Ví dụ: 2 khăn lớn trên giường, 1 khăn mặt trên kệ" />
      </label>
      <label className="check-item full">
        <input type="checkbox" name="needPhoto" value="1" defaultChecked={s ? s.needPhoto : true} />
        <span>Bắt buộc chụp ảnh mục này mới hoàn thành được phòng</span>
      </label>
      <PhotoInput name="sample" label={s?.sample ? "Đổi ảnh mẫu" : "Ảnh mẫu (không bắt buộc): ảnh phòng làm đúng chuẩn để nhân viên làm theo"} />
      {s?.sample && (
        <label className="check-item full">
          <input type="checkbox" name="removeSample" value="1" />
          <span>Xoá ảnh mẫu hiện tại</span>
        </label>
      )}
    </>
  );
}

export default async function ChecklistEditor({ searchParams }: { searchParams: Promise<Record<string, string>> }) {
  const user = await requireUser();
  if (!can(user, "assignTask")) return <NoAccess />;
  const sp = await searchParams;
  const db = getDb();
  const props = await visibleProperties(db, user);
  const own = await propertiesWithOwnTemplate(db);
  const adminDefault = canEditDefault(user);
  // Admin mở mặc định khi chưa chọn cơ sở; Quản lý mở cơ sở đầu tiên của mình
  const pick = sp.p === DEFAULT ? null : props.find((p) => p.id === sp.p)?.id ?? (adminDefault ? null : props[0]?.id ?? null);
  const tpl = await effectiveTemplate(db, pick);
  const prop = props.find((p) => p.id === pick);
  const editable = pick ? tpl.own : adminDefault;
  const scope = pick ?? "";
  const usingDefault = props.filter((p) => !own.has(p.id)).length;

  return (
    <>
      <div className="topbar"><h1>Checklist dọn phòng</h1></div>
      <CleanNav current="checklist" p={pick ?? undefined} manage />

      <nav className="chips clean-props" aria-label="Chọn checklist">
        <Link className="chip" aria-pressed={!pick} href={`/don-dep/checklist?p=${DEFAULT}`}>Mặc định</Link>
        {props.map((p) => (
          <Link key={p.id} className="chip" aria-pressed={p.id === pick} href={`/don-dep/checklist?p=${p.id}`}>
            {p.name}{own.has(p.id) ? " (riêng)" : ""}
          </Link>
        ))}
      </nav>

      <section className="panel ck-panel">
        <header>
          <div>
            <h2>{prop ? prop.name : "Checklist mặc định"}</h2>
            <p>
              {!prop ? `Dùng cho mọi cơ sở chưa có checklist riêng (hiện ${usingDefault}/${props.length} cơ sở).${adminDefault ? "" : " Chỉ Admin sửa được checklist này."}`
                : tpl.own ? "Checklist riêng của cơ sở này." : "Cơ sở này đang dùng checklist mặc định."}
              {" "}Sửa xong áp dụng cho việc dọn mới và các phòng chưa bắt đầu dọn; phòng đang dọn giữ checklist cũ.
            </p>
          </div>
          {prop && !tpl.own && (
            <ActionForm action={createOwnAction} submit="Tạo checklist riêng" okText="Đã tạo" submitClass="btn" className="row">
              <input type="hidden" name="propertyId" value={prop.id} />
            </ActionForm>
          )}
          {prop && tpl.own && (
            <ActionForm action={deleteOwnAction} submit="Bỏ checklist riêng" submitClass="btn sm danger" className="row"
              confirmText={`Xoá checklist riêng của ${prop.name}? Cơ sở sẽ quay về dùng checklist mặc định.`}>
              <input type="hidden" name="propertyId" value={prop.id} />
            </ActionForm>
          )}
        </header>

        <ol className="ck-steps">
          {tpl.steps.map((s, i) => (
            <li key={s.id}>
              <div className="ck-row">
                <span className="ck-n" aria-hidden="true">{i + 1}</span>
                <div className="ck-text">
                  <b>{s.item}</b>
                  {s.hint && <span className="small muted">{s.hint}</span>}
                  {s.needPhoto && <span><span className="pill warn">Bắt buộc ảnh</span></span>}
                </div>
                {s.sample && (
                  <a className="ck-sample" href={photoHref(s.sample)} target="_blank" rel="noreferrer" title="Xem ảnh mẫu">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={photoHref(s.sample)} alt={`Ảnh mẫu: ${s.item}`} loading="lazy" />
                  </a>
                )}
                {editable && (
                  <div className="ck-move">
                    <form action={moveStepAction}>
                      <input type="hidden" name="propertyId" value={scope} /><input type="hidden" name="stepId" value={s.id} /><input type="hidden" name="dir" value="up" />
                      <button className="btn sm" disabled={i === 0} aria-label={`Đưa "${s.item}" lên trên`}>▲</button>
                    </form>
                    <form action={moveStepAction}>
                      <input type="hidden" name="propertyId" value={scope} /><input type="hidden" name="stepId" value={s.id} /><input type="hidden" name="dir" value="down" />
                      <button className="btn sm" disabled={i === tpl.steps.length - 1} aria-label={`Đưa "${s.item}" xuống dưới`}>▼</button>
                    </form>
                  </div>
                )}
              </div>
              {editable && (
                <details className="ck-edit">
                  <summary>Sửa mục này</summary>
                  <ActionForm action={updateStepAction} submit="Lưu thay đổi">
                    <StepFields s={s} scope={scope} />
                  </ActionForm>
                  <ActionForm action={removeStepAction} submit="Xoá mục này" submitClass="btn sm danger" className="row"
                    confirmText={`Xoá "${s.item}" khỏi checklist?`}>
                    <input type="hidden" name="propertyId" value={scope} /><input type="hidden" name="stepId" value={s.id} />
                  </ActionForm>
                </details>
              )}
            </li>
          ))}
        </ol>

        {editable && tpl.steps.length < MAX_STEPS && (
          <details className="ck-add">
            <summary className="btn">Thêm mục</summary>
            <ActionForm action={addStepAction} submit="Thêm vào checklist">
              <StepFields scope={scope} />
            </ActionForm>
          </details>
        )}
      </section>
    </>
  );
}
