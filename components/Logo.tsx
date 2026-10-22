// Logo baocaodau.com: biểu tượng tờ báo cáo góc gấp + chữ "baocao" (mực) "dau" (xanh ngọc).
// Nét vẽ giống hệt bản logo gốc; ở cỡ nhỏ nét dày hơn để không bị mảnh.

const PATH = "M18 38 V14 H32 L45 27 V38 A12 12 0 0 1 33 50 H24 M32 14 V27 H45 M25 34 H37 M25 42 H32";

export function LogoMark({ size = 32, title }: { size?: number; title?: string }) {
  const small = size <= 40;
  return (
    <svg className="logo-mark" width={size} height={size} viewBox="0 0 64 64" role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <rect width="64" height="64" rx="10" fill="var(--brand)" />
      <path d={PATH} fill="none" stroke="#fff" strokeWidth={small ? 4.6 : 3.8} strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="18" cy="50" r="3.6" fill="none" stroke="#fff" strokeWidth={small ? 4 : 3.5} />
    </svg>
  );
}

export function Logo({ size = 32, tld = false }: { size?: number; tld?: boolean }) {
  return (
    <span className="logo">
      <LogoMark size={size} />
      <span className="logo-word">baocao<span className="logo-dau">dau</span>{tld && <span className="logo-tld">.com</span>}</span>
    </span>
  );
}
