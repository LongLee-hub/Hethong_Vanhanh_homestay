// Chuyển giữa tiền Airbnb chuyển (email payout) và tiền Dayladau chuyển (phiếu thanh toán).
import Link from "next/link";

export function ChannelTabs({ month, channel }: { month: string; channel: "airbnb" | "dayladau" }) {
  return (
    <nav className="chips" aria-label="Kênh thanh toán" style={{ width: "100%" }}>
      <Link className="chip" aria-pressed={channel === "airbnb"} href={`/payouts?month=${month}`}>Airbnb</Link>
      <Link className="chip" aria-pressed={channel === "dayladau"} href={`/payouts/dayladau?month=${month}`}>Dayladau</Link>
    </nav>
  );
}
