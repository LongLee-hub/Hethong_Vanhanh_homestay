// Hiện ngay khi bấm chuyển trang, trong lúc máy chủ đọc số liệu; thanh điều hướng vẫn giữ nguyên.
export default function Loading() {
  return (
    <div role="status" aria-live="polite">
      <span className="sr-only">Đang tải…</span>
      <div className="topbar"><i className="skel" style={{ width: 240, height: 32 }} /></div>
      <section className="hero" aria-hidden="true">
        <div className="stack" style={{ gap: 12 }}>
          <i className="skel" style={{ width: "50%", height: 16 }} />
          <i className="skel" style={{ width: "70%", height: 44 }} />
          <i className="skel" style={{ width: "90%", height: 14 }} />
        </div>
        <div className="stack" style={{ gap: 12 }}>
          {[0, 1, 2, 3].map((i) => <i key={i} className="skel" style={{ height: 16 }} />)}
        </div>
      </section>
      <div className="cards" aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="stat">
            <i className="skel" style={{ width: "60%", height: 14 }} />
            <i className="skel" style={{ width: "80%", height: 28 }} />
          </div>
        ))}
      </div>
    </div>
  );
}
