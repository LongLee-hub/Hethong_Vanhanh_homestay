"use client";
// Máy ảnh chấm công: chụp tại chỗ, in giờ, ngày, cơ sở, tọa độ GPS và tên nhân viên lên ảnh rồi gửi kèm form.
// Ảnh in dấu ở trình duyệt (canvas) nên người quản lý xem ảnh là thấy ngay chụp lúc nào, ở đâu.
// Máy không mở được camera trực tiếp (trình duyệt cũ, bị chặn quyền) thì dùng ô chụp ảnh của điện thoại, vẫn in dấu như trên.
import { useCallback, useEffect, useRef, useState } from "react";
import css from "./CameraStamp.module.css";

export type StampProperty = { id: string; name: string; address: string | null };
type Geo = { lat: number; lng: number; acc: number } | null;
type GeoState = "waiting" | "ok" | "denied" | "unsupported";

const TZ = "Asia/Ho_Chi_Minh";
const fmtTime = (d: Date) => d.toLocaleTimeString("vi-VN", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });
const fmtDate = (d: Date) => {
  const s = d.toLocaleDateString("vi-VN", { timeZone: TZ, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  return s.charAt(0).toUpperCase() + s.slice(1);
};
const fmtGeo = (g: Geo) => (g ? `${g.lat.toFixed(6)}, ${g.lng.toFixed(6)} (±${Math.round(g.acc)} m)` : "Không lấy được vị trí");

/** In khối dấu thời gian vào góc dưới trái ảnh. Cỡ chữ theo cạnh ngắn của ảnh để ảnh nhỏ hay lớn đều đọc được. */
export function drawStamp(ctx: CanvasRenderingContext2D, w: number, h: number, at: Date, place: StampProperty | undefined, geo: Geo, who: string, shift: string) {
  const u = Math.min(w, h) / 100; // 1 đơn vị = 1% cạnh ngắn
  const pad = 3 * u;
  const big = 11 * u;
  const small = 3.4 * u;
  const lines = [fmtDate(at), place?.name ?? "", place?.address ?? "", fmtGeo(geo), `${who} · ${shift}`].filter(Boolean);
  const lineH = small * 1.45;
  const blockH = big * 1.05 + lines.length * lineH + pad;
  const x = pad;
  const y = h - pad - blockH;

  // Nền mờ phía dưới để chữ trắng đọc được trên ảnh sáng
  const g = ctx.createLinearGradient(0, h - blockH - pad * 3, 0, h);
  g.addColorStop(0, "rgba(0,0,0,0)");
  g.addColorStop(1, "rgba(0,0,0,.62)");
  ctx.fillStyle = g;
  ctx.fillRect(0, h - blockH - pad * 3, w, blockH + pad * 3);

  ctx.fillStyle = "#2e9c92"; // xanh ngọc logo
  ctx.fillRect(x, y + big * 0.12, 0.9 * u, blockH - pad * 0.6);

  ctx.fillStyle = "#fff";
  ctx.textBaseline = "top";
  ctx.shadowColor = "rgba(0,0,0,.45)";
  ctx.shadowBlur = u;
  const tx = x + 3 * u;
  ctx.font = `600 ${big}px "Be Vietnam Pro", system-ui, sans-serif`;
  ctx.fillText(fmtTime(at), tx, y);
  ctx.font = `500 ${small}px "Be Vietnam Pro", system-ui, sans-serif`;
  lines.forEach((t, i) => ctx.fillText(t, tx, y + big * 1.05 + i * lineH, w - tx - pad));
  ctx.shadowBlur = 0;

  // Dấu nhận diện góc phải để ảnh chụp lại màn hình khó giả hơn
  ctx.font = `600 ${small * 0.9}px "Be Vietnam Pro", system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.fillStyle = "rgba(255,255,255,.85)";
  ctx.fillText("baocaodau · chấm công", w - pad, h - pad - small);
  ctx.textAlign = "left";
}

export function CameraStamp({ properties, userName, shifts, name = "photo" }: {
  properties: StampProperty[];
  userName: string;
  /** Các ca còn vào được hôm nay. */
  shifts: { value: string; label: string; hint?: string }[];
  name?: string;
}) {
  const [shift, setShift] = useState(shifts[0]?.value ?? "MORNING");
  const shiftLabel = shifts.find((x) => x.value === shift)?.label ?? "";
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? "");
  const place = properties.find((p) => p.id === propertyId);
  const [geo, setGeo] = useState<Geo>(null);
  const [geoState, setGeoState] = useState<GeoState>("waiting");
  const [now, setNow] = useState(() => new Date());
  const [live, setLive] = useState(false);
  const [facing, setFacing] = useState<"user" | "environment">("user");
  const [camError, setCamError] = useState<string | null>(null);
  const [shot, setShot] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  const stream = useRef<MediaStream | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const lastFile = useRef<File | null>(null);

  // React xóa form sau mỗi lần gửi; gửi lỗi (vd mất mạng) thì gắn lại ảnh đã chụp để khỏi phải chụp lại
  useEffect(() => {
    const form = fileInput.current?.form;
    if (!form) return;
    const onReset = () => setTimeout(() => {
      if (!lastFile.current || !fileInput.current) return;
      const dt = new DataTransfer();
      dt.items.add(lastFile.current);
      fileInput.current.files = dt.files;
    });
    form.addEventListener("reset", onReset);
    return () => form.removeEventListener("reset", onReset);
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!("geolocation" in navigator)) { setGeoState("unsupported"); return; }
    const id = navigator.geolocation.watchPosition(
      (p) => { setGeo({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }); setGeoState("ok"); },
      () => setGeoState((s) => (s === "ok" ? s : "denied")),
      { enableHighAccuracy: true, maximumAge: 15_000, timeout: 20_000 },
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);

  const stop = useCallback(() => {
    stream.current?.getTracks().forEach((t) => t.stop());
    stream.current = null;
    setLive(false);
  }, []);
  useEffect(() => stop, [stop]);

  async function start(f = facing) {
    setCamError(null);
    if (!navigator.mediaDevices?.getUserMedia) { setCamError("Máy không mở được camera trong trang. Dùng nút Chụp bằng điện thoại bên dưới."); return; }
    try {
      stop();
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: f, width: { ideal: 1600 }, height: { ideal: 1600 } }, audio: false });
      stream.current = s;
      setLive(true);
      setShot(null);
      requestAnimationFrame(() => { if (video.current) { video.current.srcObject = s; video.current.play().catch(() => {}); } });
    } catch {
      setCamError("Chưa được cấp quyền camera. Cho phép camera cho trang này trong cài đặt trình duyệt, hoặc dùng nút Chụp bằng điện thoại.");
    }
  }

  /** Vẽ nguồn ảnh lên canvas tối đa 1600px, in dấu, rồi gắn vào ô file ẩn của form. */
  async function finish(src: CanvasImageSource, sw: number, sh: number, mirror: boolean) {
    const k = Math.min(1, 1600 / Math.max(sw, sh));
    const c = document.createElement("canvas");
    c.width = Math.round(sw * k);
    c.height = Math.round(sh * k);
    const ctx = c.getContext("2d")!;
    if (mirror) { ctx.translate(c.width, 0); ctx.scale(-1, 1); }
    ctx.drawImage(src, 0, 0, c.width, c.height);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    drawStamp(ctx, c.width, c.height, new Date(), place, geo, userName, shiftLabel);
    const blob: Blob | null = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.85));
    if (!blob || !fileInput.current) return;
    const dt = new DataTransfer();
    lastFile.current = new File([blob], `cham-cong-${Date.now()}.jpg`, { type: "image/jpeg" });
    dt.items.add(lastFile.current);
    fileInput.current.files = dt.files;
    setShot((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob); });
  }

  async function capture() {
    const v = video.current;
    if (!v || !v.videoWidth) return;
    await finish(v, v.videoWidth, v.videoHeight, facing === "user");
    stop();
  }

  async function fromPhone(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.currentTarget.files?.[0];
    if (!f) return;
    const bmp = await createImageBitmap(f);
    await finish(bmp, bmp.width, bmp.height, false);
    e.currentTarget.value = "";
  }

  function retake() {
    lastFile.current = null;
    if (fileInput.current) fileInput.current.value = "";
    setShot(null);
    void start();
  }

  return (
    <div className={`full ${css.wrap}`}>
      <fieldset className={css.shifts}>
        <legend>Ca làm</legend>
        {shifts.map((x) => (
          <label key={x.value} className={css.shift} aria-checked={shift === x.value}>
            <input type="radio" name="shift" value={x.value} checked={shift === x.value} onChange={() => { setShift(x.value); if (shot) retake(); }} />
            <b>{x.label}</b>{x.hint && <span className="small muted">{x.hint}</span>}
          </label>
        ))}
      </fieldset>
      <label className="field">
        <span>Cơ sở</span>
        <select name="propertyId" id="propertyId" value={propertyId} onChange={(e) => { setPropertyId(e.target.value); if (shot) retake(); }}>
          {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
      </label>

      <div className={css.frame} data-state={shot ? "shot" : live ? "live" : "idle"}>
        {shot ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={shot} alt="Ảnh vào ca đã in giờ và vị trí" className={css.media} />
        ) : live ? (
          <>
            <video ref={video} className={`${css.media} ${facing === "user" ? css.mirror : ""}`} playsInline muted />
            <div className={css.stamp} aria-hidden="true">
              <b className={css.time}>{fmtTime(now)}</b>
              <span>{fmtDate(now)}</span>
              <span>{place?.name}</span>
              {place?.address && <span>{place.address}</span>}
              <span>{fmtGeo(geo)}</span>
            </div>
          </>
        ) : (
          <button type="button" className={css.open} onClick={() => start()}>
            <svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 8a2 2 0 0 1 2-2h2l1.5-2h7L17 6h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /><circle cx="12" cy="13" r="4" /></svg>
            <b>Mở máy ảnh</b>
            <span className="small">Chụp ảnh tại cơ sở. Giờ, ngày và vị trí được in lên ảnh.</span>
          </button>
        )}
      </div>

      <div className={css.controls}>
        {live && !shot && (
          <>
            <button type="button" className={css.shutter} onClick={capture} aria-label="Chụp ảnh"><i /></button>
            <button type="button" className="btn sm" onClick={() => { const f = facing === "user" ? "environment" : "user"; setFacing(f); void start(f); }}>Đổi camera</button>
          </>
        )}
        {shot && <button type="button" className="btn sm" onClick={retake}>Chụp lại</button>}
        {!live && !shot && (
          <label className="btn sm">
            Chụp bằng điện thoại
            <input type="file" accept="image/*" capture="user" className="sr-only" onChange={fromPhone} />
          </label>
        )}
      </div>

      <p className={`small ${geoState === "ok" ? "muted" : "neg"}`} role="status">
        {geoState === "ok" && geo ? `Đã lấy vị trí, sai số khoảng ${Math.round(geo.acc)} m.`
          : geoState === "waiting" ? "Đang lấy vị trí… Bật định vị (GPS) trên điện thoại nếu chờ lâu."
          : geoState === "denied" ? "Chưa được cấp quyền vị trí. Cho phép vị trí cho trang này để ảnh có tọa độ."
          : "Máy không hỗ trợ định vị, ảnh sẽ không có tọa độ."}
      </p>
      {camError && <p className="small neg">{camError}</p>}

      <input ref={fileInput} type="file" name={name} accept="image/jpeg" className="sr-only" tabIndex={-1} aria-hidden="true" />
      <input type="hidden" name="lat" value={geo?.lat ?? ""} />
      <input type="hidden" name="lng" value={geo?.lng ?? ""} />
      <input type="hidden" name="accuracy" value={geo ? Math.round(geo.acc) : ""} />
    </div>
  );
}
