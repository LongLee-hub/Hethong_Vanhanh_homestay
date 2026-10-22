"use client";
// Ô chọn phòng cho dòng payout chưa khớp đơn. Gán theo listing Airbnb nên đổi một ô là đổi mọi dòng cùng listing.
import { useState, useTransition } from "react";
import { assignListingRoomAction } from "./actions";

export type RoomOption = { id: string; name: string; property: string };

export function AssignRoom({ investorId, listingKey, nickname, roomId, rooms }: {
  investorId: string;
  listingKey: string;
  nickname: string;
  roomId: string | null;
  rooms: RoomOption[];
}) {
  const [error, setError] = useState("");
  const [pending, start] = useTransition();
  const props = [...new Set(rooms.map((r) => r.property))];
  return (
    <div className="assign-room">
      <select
        value={roomId ?? ""}
        disabled={pending}
        aria-label={`Phòng cho listing ${nickname || listingKey}`}
        title="Gán theo listing Airbnb: áp dụng cho mọi payout của listing này"
        onChange={(e) => {
          const next = e.target.value || null;
          start(async () => {
            const r = await assignListingRoomAction({ investorId, listingKey, roomId: next });
            setError(r?.ok ? "" : r?.error ?? "");
          });
        }}
      >
        <option value="">— Chưa gán phòng —</option>
        {props.map((p) => <optgroup key={p} label={p}>{rooms.filter((r) => r.property === p).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</optgroup>)}
      </select>
      <div className="small muted">{pending ? "Đang lưu…" : `Listing ${nickname || listingKey}`}</div>
      {error && <div className="err small" role="alert">{error}</div>}
    </div>
  );
}
