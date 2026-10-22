"use client";
// Lỗi khi dựng trang. Bản production không gửi nội dung lỗi ra trình duyệt, chỉ có mã (digest)
// trùng với dòng lỗi trong log máy chủ (pm2 logs / journalctl), để tra đúng nguyên nhân.
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="empty" style={{ paddingTop: "12vh" }}>
      <h2>Không tải được trang</h2>
      <p>Có lỗi khi đọc dữ liệu. Thử lại, nếu vẫn lỗi hãy báo Admin.</p>
      {error.digest && <p className="small muted">Mã lỗi: <code>{error.digest}</code></p>}
      <button className="btn" onClick={reset}>Thử lại</button>
    </div>
  );
}
