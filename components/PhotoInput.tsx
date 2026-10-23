"use client";
// Ô chọn ảnh: nén về tối đa 1600px JPEG trước khi gửi (Đặc tả mục 3: nén trước khi tải lên).
// camera: mở thẳng máy ảnh trên điện thoại; mặc định cho chọn ảnh có sẵn trong thư viện.
export function PhotoInput({ name, required, label, camera }: { name: string; required?: boolean; label: string; camera?: boolean }) {
  async function onChange(e: React.ChangeEvent<HTMLInputElement>) {
    const input = e.currentTarget;
    const f = input.files?.[0];
    if (!f || !f.type.startsWith("image/")) return;
    try {
      const bmp = await createImageBitmap(f);
      const k = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      const c = document.createElement("canvas");
      c.width = Math.round(bmp.width * k);
      c.height = Math.round(bmp.height * k);
      c.getContext("2d")!.drawImage(bmp, 0, 0, c.width, c.height);
      const blob: Blob | null = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.82));
      if (!blob) return;
      const dt = new DataTransfer();
      dt.items.add(new File([blob], f.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }));
      input.files = dt.files;
    } catch {
      /* giữ ảnh gốc */
    }
  }
  return (
    <label className="field full">
      <span>{label}</span>
      <input type="file" name={name} id={name} accept="image/*" capture={camera ? "environment" : undefined} required={required} onChange={onChange} />
    </label>
  );
}
