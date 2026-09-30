// Sinh dữ liệu MẪU cho bản chạy thử. Mọi bản ghi đều có sample: true.
// Tên cơ sở là cơ sở thật của LOCI; số phòng, giá, NĐT, đơn và chi phí là giả lập.

import {
  BookingLite,
  addDays,
  firstDay,
  lastDay,
  monthOf,
  settleInvestorMonth,
  splitNights,
} from "../lib/domain";

type Doc = Record<string, unknown> & { id: string };
export type SeedData = Record<string, Doc[]>;

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export const CHANNELS = ["Airbnb", "Booking", "Agoda", "Trực tiếp"];
export const DEFAULT_COMMISSION: Record<string, number> = { Airbnb: 15, Booking: 15, Agoda: 18, "Trực tiếp": 0 };
export const DEFAULT_CHECKLIST = [
  "Thay ga, vỏ gối, khăn tắm",
  "Hút bụi, lau sàn",
  "Vệ sinh nhà tắm, bồn cầu",
  "Bổ sung nước, trà, đồ vệ sinh cá nhân",
  "Kiểm tra điều hòa, đèn, remote",
  "Đổ rác, thay túi rác",
  "Chụp ảnh phòng sau khi dọn",
];
export const EXPENSE_CATEGORIES = [
  ["cat-rent", "Thuê nhà", "DIRECT"],
  ["cat-util", "Điện nước", "DIRECT"],
  ["cat-net", "Internet", "DIRECT"],
  ["cat-supply", "Vật tư tiêu hao", "DIRECT"],
  ["cat-laundry", "Giặt là", "DIRECT"],
  ["cat-maint", "Bảo trì", "DIRECT"],
  ["cat-salary", "Lương", "COMMON"],
  ["cat-mkt", "Marketing", "COMMON"],
  ["cat-soft", "Phần mềm", "COMMON"],
  ["cat-tax", "Thuế", "DIRECT"],
] as const;

export function makeSampleData(today: string): SeedData {
  const r = rng(20260930);
  const pick = <T,>(a: readonly T[]) => a[Math.floor(r() * a.length)];

  const investors: Doc[] = [
    { id: "inv-a", name: "Nhà đầu tư A (mẫu)", dayladauHostId: "", sample: true },
    { id: "inv-b", name: "Nhà đầu tư B (mẫu)", dayladauHostId: "", sample: true },
  ];

  const propDefs = [
    { id: "p-vanphuc", name: "Vạn Phúc", investorId: "inv-a", n: 5, price: 780_000, inv: 650_000_000, fixed: 28_000_000 },
    { id: "p-phankebinh", name: "Phan Kế Bính", investorId: "inv-a", n: 4, price: 690_000, inv: 480_000_000, fixed: 24_000_000 },
    { id: "p-nguyentugian", name: "Nguyễn Tư Giản", investorId: "inv-b", n: 4, price: 620_000, inv: 420_000_000, fixed: 21_000_000 },
  ];

  const properties: Doc[] = propDefs.map((p) => ({
    id: p.id,
    name: p.name,
    investorId: p.investorId,
    address: "",
    investmentAmount: p.inv,
    investmentStartMonth: "2026-07",
    occupancyKpiPct: 70,
    fixedCostMonthly: p.fixed,
    variableCostPerNight: 60_000,
    active: true,
    rooms: Array.from({ length: p.n }, (_, i) => ({
      id: `${p.id}-r${i + 1}`,
      name: `P${i + 1}0${(i % 3) + 1}`,
      openedOn: "2026-06-01",
      closedOn: null,
      dayladauRoomId: "",
    })),
    sample: true,
  }));

  // ---- Đơn đặt phòng, gom theo cơ sở × tháng check-in ----
  const buckets = new Map<string, BookingLite[] & any[]>();
  const allBookings: any[] = [];
  let seq = 1;
  const start = "2026-07-01";
  const end = "2026-11-15";
  for (const p of propDefs) {
    for (let i = 0; i < p.n; i++) {
      const roomId = `${p.id}-r${i + 1}`;
      let d = addDays(start, Math.floor(r() * 3));
      while (d < end) {
        const nights = 1 + Math.floor(r() * 4);
        const checkOut = addDays(d, nights);
        const lead = Math.floor(r() * r() * 45);
        const bookedAt = addDays(d, -lead);
        if (bookedAt <= today) {
          const channel = r() < 0.12 ? "Trực tiếp" : pick(["Airbnb", "Airbnb", "Booking", "Agoda"]);
          const weekendBoost = 1 + (r() < 0.3 ? 0.15 : 0);
          const gross = Math.round((p.price * nights * weekendBoost * (0.9 + r() * 0.2)) / 10_000) * 10_000;
          const commission = Math.round((gross * DEFAULT_COMMISSION[channel]) / 100);
          const cancelled = r() < 0.04;
          const b = {
            id: `bk-${String(seq++).padStart(4, "0")}`,
            source: channel === "Trực tiếp" ? "MANUAL" : "DAYLADAU",
            externalId: channel === "Trực tiếp" ? null : `DLD${100000 + seq * 7}`,
            propertyId: p.id,
            roomId,
            channel,
            guestName: pick(["Nguyễn Minh", "Trần Hà", "Lê Quang", "Emma W.", "Kenji S.", "Phạm Thu", "David L.", "Hoàng Anh", "Park J.", "Vũ Lan", "Sophie M.", "Đỗ Hùng"]),
            bookedAt,
            checkIn: d,
            checkOut,
            grossAmount: gross,
            commissionAmount: commission,
            netAmount: cancelled ? 0 : gross - commission,
            status: cancelled ? "CANCELLED" : "CONFIRMED",
            transferProof: channel === "Trực tiếp" ? "CK Vietcombank (mẫu)" : "",
            log: [],
          };
          allBookings.push(b);
          const key = `${p.id}__${monthOf(d)}`;
          if (!buckets.has(key)) buckets.set(key, [] as any);
          buckets.get(key)!.push(b);
        }
        d = addDays(checkOut, r() < 0.45 ? 0 : 1 + Math.floor(r() * 3));
      }
    }
  }
  const bookingBuckets: Doc[] = [...buckets.entries()].map(([key, items]) => {
    const [propertyId, month] = key.split("__");
    return { id: `${propertyId}__${month}`, propertyId, month, items, sample: true };
  });

  // ---- Chi phí ----
  const expenses: Doc[] = [];
  let eseq = 1;
  const months = ["2026-07", "2026-08", "2026-09"];
  for (const m of months) {
    for (const p of propDefs) {
      const add = (categoryId: string, amount: number, description: string, paid: boolean) =>
        expenses.push({
          id: `ex-${String(eseq++).padStart(4, "0")}`,
          propertyId: p.id,
          categoryId,
          month: m,
          incurredOn: `${m}-${String(3 + Math.floor(r() * 24)).padStart(2, "0")}`,
          amount,
          description,
          paymentStatus: paid ? "PAID" : "UNPAID",
          paidAt: paid ? `${m}-28` : null,
          receiptIds: [],
          taskId: null,
          sample: true,
        });
      const past = m !== "2026-09";
      add("cat-rent", p.fixed - 3_000_000, `Tiền thuê nhà ${p.name}`, true);
      add("cat-util", 2_400_000 + Math.floor(r() * 12) * 100_000, "Điện nước", past);
      add("cat-net", 450_000, "Internet FPT", past);
      add("cat-supply", 1_100_000 + Math.floor(r() * 8) * 100_000, "Nước, trà, đồ vệ sinh", past || r() < 0.5);
      add("cat-laundry", 1_600_000 + Math.floor(r() * 10) * 100_000, "Giặt là ga gối", past);
      if (r() < 0.5) add("cat-maint", 350_000 + Math.floor(r() * 10) * 100_000, "Sửa vòi sen / thay bóng đèn", past);
    }
    if (m !== "2026-09") {
      const common = (categoryId: string, amount: number, description: string) =>
        expenses.push({
          id: `ex-${String(eseq++).padStart(4, "0")}`,
          propertyId: null,
          categoryId,
          month: m,
          incurredOn: `${m}-28`,
          amount,
          description,
          paymentStatus: "PAID",
          paidAt: `${m}-30`,
          receiptIds: [],
          taskId: null,
          sample: true,
        });
      common("cat-salary", 9_000_000, "Lương quản lý vận hành (phần chia hệ thống mẫu)");
      common("cat-soft", 1_300_000, "Phần mềm Dayladau");
      common("cat-mkt", 1_500_000, "Chụp ảnh, quảng cáo");
    }
  }

  const categories: Doc[] = EXPENSE_CATEGORIES.map(([id, name, scope]) => ({ id, name, scope, active: true }));

  // ---- Kỳ và quyết toán ----
  const periods: Doc[] = [
    { id: "2026-07", commonCostsFinalized: true, sample: true },
    { id: "2026-08", commonCostsFinalized: true, sample: true },
    { id: "2026-09", commonCostsFinalized: false, sample: true },
  ];

  const rooms = properties.flatMap((p: any) => p.rooms.map((rm: any) => ({ ...rm, propertyId: p.id })));
  const nights = allBookings.flatMap((b) => splitNights(b));
  const settlements: Doc[] = investors.map((inv) => {
    const pids = properties.filter((p: any) => p.investorId === inv.id).map((p) => p.id);
    const s = settleInvestorMonth({
      month: "2026-07",
      propertyIds: pids,
      rooms,
      nights,
      expenses: expenses as any,
      adjustments: [],
      commonFinalized: true,
      feePct: 20,
    });
    return {
      id: `${inv.id}__2026-07`,
      investorId: inv.id,
      month: "2026-07",
      status: "LOCKED",
      ...s,
      lockedAt: "2026-08-05T09:00:00+07:00",
      lockedBy: "Admin LOCI",
      sample: true,
    };
  });

  // ---- Nhân sự (vai trò để xem thử) ----
  const staff: Doc[] = [
    { id: "u-admin", name: "Admin LOCI", role: "ADMIN", propertyIds: [], investorId: null },
    { id: "u-inv-a", name: "Nhà đầu tư A (mẫu)", role: "INVESTOR", propertyIds: [], investorId: "inv-a" },
    { id: "u-inv-b", name: "Nhà đầu tư B (mẫu)", role: "INVESTOR", propertyIds: [], investorId: "inv-b" },
    { id: "u-mgr", name: "Quản lý Hương (mẫu)", role: "MANAGER", propertyIds: ["p-vanphuc", "p-phankebinh"], investorId: null },
    { id: "u-acc", name: "Kế toán Mai (mẫu)", role: "ACCOUNTANT", propertyIds: ["p-vanphuc", "p-phankebinh", "p-nguyentugian"], investorId: null },
    { id: "u-hk1", name: "Buồng phòng Lan (mẫu)", role: "HOUSEKEEPER", propertyIds: ["p-vanphuc"], investorId: null },
    { id: "u-hk2", name: "Buồng phòng Tú (mẫu)", role: "HOUSEKEEPER", propertyIds: ["p-phankebinh", "p-nguyentugian"], investorId: null },
  ].map((s) => ({ ...s, active: true, sample: true }));

  // ---- Công việc ----
  const tasks: Doc[] = [];
  let tseq = 1;
  const mkTask = (t: Record<string, unknown>) =>
    tasks.push({
      id: `t-${String(tseq++).padStart(3, "0")}`,
      assignedById: "u-mgr",
      priority: "MEDIUM",
      status: "TODO",
      description: "",
      completedAt: null,
      photoIds: [],
      checklist: null,
      bookingId: null,
      roomId: null,
      sample: true,
      ...t,
    });
  // Việc dọn phòng từ đơn check-out hôm qua và hôm nay
  for (const b of allBookings.filter((b) => b.status === "CONFIRMED" && (b.checkOut === today || b.checkOut === addDays(today, -1)))) {
    const done = b.checkOut < today;
    const hk = b.propertyId === "p-vanphuc" ? "u-hk1" : "u-hk2";
    mkTask({
      type: "CLEANING",
      title: `Dọn phòng sau check-out – ${b.guestName}`,
      propertyId: b.propertyId,
      roomId: b.roomId,
      bookingId: b.id,
      assigneeId: hk,
      dueAt: `${b.checkOut}T14:00`,
      status: done ? "DONE" : "TODO",
      completedAt: done ? `${b.checkOut}T12:40` : null,
      checklist: DEFAULT_CHECKLIST.map((item) => ({ item, done })),
    });
  }
  mkTask({ type: "MAINTENANCE", title: "Điều hòa phòng P201 kêu to", propertyId: "p-vanphuc", roomId: "p-vanphuc-r2", assigneeId: "u-mgr", dueAt: `${addDays(today, -2)}T17:00`, priority: "HIGH", status: "IN_PROGRESS" });
  mkTask({ type: "PURCHASE", title: "Mua 20 bộ khăn tắm mới", propertyId: "p-phankebinh", assigneeId: "u-mgr", dueAt: `${addDays(today, 3)}T17:00` });
  mkTask({ type: "BAD_REVIEW", title: "Phản hồi đánh giá 3★ trên Booking", propertyId: "p-nguyentugian", assigneeId: "u-mgr", dueAt: `${today}T20:00`, priority: "HIGH" });
  mkTask({ type: "RECURRING", title: "Vệ sinh lưới lọc điều hòa định kỳ", propertyId: "p-nguyentugian", assigneeId: "u-hk2", dueAt: `${addDays(today, 5)}T17:00`, recurrenceRule: "monthly:5" });
  mkTask({ type: "INVENTORY", title: "Kiểm kho vật tư cuối tháng", propertyId: "p-vanphuc", assigneeId: "u-hk1", dueAt: `${lastDay(monthOf(today))}T18:00` });

  // ---- Chấm công (1 tài liệu / tháng) ----
  const attendance: Doc[] = [];
  const rows: any[] = [];
  for (let d = firstDay(monthOf(today)); d < today; d = addDays(d, 1)) {
    for (const [uid, pid] of [["u-hk1", "p-vanphuc"], ["u-hk2", "p-phankebinh"], ["u-mgr", "p-vanphuc"]] as const) {
      if (r() < 0.14) continue;
      const inM = 30 + Math.floor(r() * 50);
      rows.push({
        id: `${uid}-${d}`,
        userId: uid,
        propertyId: pid,
        date: d,
        checkInAt: `${d}T0${7 + Math.floor(inM / 60)}:${String(inM % 60).padStart(2, "0")}`,
        checkOutAt: `${d}T1${6 + Math.floor(r() * 2)}:${String(Math.floor(r() * 60)).padStart(2, "0")}`,
      });
    }
  }
  attendance.push({ id: monthOf(today), month: monthOf(today), rows, sample: true });

  const config: Doc[] = [
    {
      id: "app",
      managementFeePct: 20,
      commission: DEFAULT_COMMISSION,
      checklist: DEFAULT_CHECKLIST,
      syncTime: "06:00",
      larkWebhook: "",
    },
  ];

  return {
    investors,
    properties,
    bookings: bookingBuckets,
    expenses,
    categories,
    periods,
    settlements,
    adjustments: [],
    staff,
    tasks,
    attendance,
    config,
  };
}
