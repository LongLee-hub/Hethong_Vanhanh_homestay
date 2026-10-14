"use client";
// Thêm phòng: lấy danh sách listing từ API Dayladau của chủ đầu tư, chọn một listing rồi đặt tên phòng và cơ sở.
import { useState, useTransition } from "react";
import type { ListingSummary } from "@/lib/dayladau/admin";
import { createRoomAction, listingsAction } from "./actions";

type Opt = { id: string; name: string };

export function AddRoom({ investorId, propertyId, properties, roomLabel, today }: {
  investorId: string;
  propertyId: string;
  properties: Opt[]; // cơ sở đang hoạt động cùng chủ đầu tư
  roomLabel: Record<string, string>; // roomId -> "Cơ sở · Phòng", để báo listing đã gắn phòng nào
  today: string;
}) {
  const [listings, setListings] = useState<ListingSummary[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [prop, setProp] = useState(propertyId);
  const [openedOn, setOpenedOn] = useState(today);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [loading, startLoad] = useTransition();
  const [saving, startSave] = useTransition();

  const load = () =>
    startLoad(async () => {
      setLoadErr("");
      const r = await listingsAction(investorId);
      setListings(r.listings);
      if (!r.ok) setLoadErr(r.error ?? "Không lấy được danh sách phòng từ Dayladau");
    });

  const pick = (l: ListingSummary) => {
    setKey(l.key);
    setName(l.name);
    setMsg(null);
  };

  const save = () =>
    startSave(async () => {
      const r = await createRoomAction({ propertyId: prop, name, openedOn, listingKey: key || undefined });
      setMsg({ ok: !!r?.ok, text: r?.ok ? "Đã thêm phòng" : r?.error ?? "Lỗi máy chủ" });
      if (r?.ok) {
        setListings((ls) => ls?.map((l) => (l.key === key ? { ...l, roomId: "new" } : l)) ?? null);
        setKey("");
        setName("");
      }
    });

  const free = listings?.filter((l) => !l.roomId) ?? [];
  const taken = listings?.filter((l) => l.roomId) ?? [];

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="row">
        <button type="button" className="btn sm" onClick={load} disabled={loading}>
          {loading ? "Đang tải…" : listings ? "Tải lại danh sách" : "Lấy danh sách phòng từ Dayladau"}
        </button>
        {listings && !loadErr && <span className="small muted">{free.length} phòng chưa gắn · {taken.length} đã gắn</span>}
      </div>
      {loadErr && <div className="banner bad">{loadErr}</div>}

      {listings && (
        <ul className="listing-list" role="radiogroup" aria-label="Phòng trên Dayladau">
          {free.map((l) => (
            <li key={l.key}>
              <label className="listing" aria-checked={key === l.key}>
                <input type="radio" name={`listing-${propertyId}`} checked={key === l.key} onChange={() => pick(l)} />
                <span className="listing-name"><b>{l.name}</b><span className="small muted">Mã {l.key} · {l.orders} đơn gần đây</span></span>
              </label>
            </li>
          ))}
          {taken.map((l) => (
            <li key={l.key}>
              <div className="listing off">
                <input type="radio" disabled aria-label="Đã gắn" />
                <span className="listing-name"><b>{l.name}</b><span className="small muted">Đã gắn: {l.roomId && roomLabel[l.roomId] ? roomLabel[l.roomId] : "phòng vừa thêm"}</span></span>
              </div>
            </li>
          ))}
          {!listings.length && !loadErr && <li className="small muted" style={{ padding: 12 }}>Chưa thấy phòng nào trong các đơn gần đây trên Dayladau.</li>}
        </ul>
      )}

      <div className="form-grid">
        <label className="field full"><span>Tên phòng</span>
          <input type="text" value={name} onChange={(e) => setName(e.target.value)} id={`room-name-${propertyId}`} placeholder={key ? "" : "Chọn một phòng ở trên, hoặc nhập tên để thêm phòng không gắn Dayladau"} />
        </label>
        <label className="field"><span>Cơ sở</span>
          <select value={prop} onChange={(e) => setProp(e.target.value)} id={`room-prop-${propertyId}`}>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label className="field"><span>Ngày mở bán</span>
          <input type="date" value={openedOn} onChange={(e) => setOpenedOn(e.target.value)} id={`room-open-${propertyId}`} />
        </label>
        <div className="full row">
          <button type="button" className="btn primary" onClick={save} disabled={saving || !name.trim()}>
            {saving ? "Đang lưu…" : key ? "Thêm phòng và gắn listing" : "Thêm phòng"}
          </button>
          {key && <button type="button" className="btn sm" onClick={() => { setKey(""); setName(""); }}>Bỏ chọn</button>}
          {msg && <span className={msg.ok ? "small pos" : "err"}>{msg.text}</span>}
        </div>
      </div>
    </div>
  );
}
