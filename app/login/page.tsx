"use client";
import { useState } from "react";

export default function LoginPage() {
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const f = new FormData(e.currentTarget);
    const res = await fetch("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ login: f.get("login"), password: f.get("password") }) });
    const data = await res.json();
    setBusy(false);
    if (!res.ok) return setError(data.error ?? "Đăng nhập không thành công");
    location.href = data.role === "HOUSEKEEPER" ? "/tasks" : "/";
  }
  return (
    <form className="login panel" onSubmit={submit}>
      <div className="brand"><b>LOCI</b><span>Homestay Manager</span></div>
      <label className="field"><span>Số điện thoại hoặc email</span><input type="text" name="login" id="login" autoComplete="username" required /></label>
      <label className="field"><span>Mật khẩu</span><input type="password" name="password" id="password" autoComplete="current-password" required /></label>
      {error && <p className="err">{error}</p>}
      <button className="btn primary" disabled={busy}>{busy ? "Đang đăng nhập…" : "Đăng nhập"}</button>
    </form>
  );
}
