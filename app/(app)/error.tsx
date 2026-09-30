"use client";
export default function Error({ reset }: { reset: () => void }) {
  return (
    <div className="empty" style={{ paddingTop: "12vh" }}>
      <h2>Không tải được trang</h2>
      <p>Có lỗi khi đọc dữ liệu. Thử lại, nếu vẫn lỗi hãy báo Admin.</p>
      <button className="btn" onClick={reset}>Thử lại</button>
    </div>
  );
}
