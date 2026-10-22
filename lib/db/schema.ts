// LOCI Homestay Manager – mô hình dữ liệu (Đặc tả mục 4), viết bằng Drizzle ORM.
// Tiền: bigint VND, đọc ra dạng number (an toàn tới 9 triệu tỷ). Ngày đêm phòng: date, đọc ra "YYYY-MM-DD".
// Tháng: chuỗi "YYYY-MM".

import { sql } from "drizzle-orm";
import {
  bigint, boolean, date, index, integer, jsonb, numeric, pgEnum, pgTable, primaryKey, text, timestamp, uniqueIndex,
} from "drizzle-orm/pg-core";

const id = () => text("id").primaryKey().$defaultFn(() => crypto.randomUUID());
const money = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);
const day = (name: string) => date(name, { mode: "string" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

// ---------- 4.1 Danh mục ----------
export const roleEnum = pgEnum("role", ["ADMIN", "INVESTOR", "MANAGER", "ACCOUNTANT", "HOUSEKEEPER"]);

export const users = pgTable("users", {
  id: id(),
  name: text("name").notNull(),
  phone: text("phone").unique(),
  email: text("email").unique(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").notNull(),
  active: boolean("active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const investors = pgTable("investors", {
  id: id(),
  name: text("name").notNull(),
  userId: text("user_id").unique().references(() => users.id),
  // Liên hệ và pháp lý
  phone: text("phone"),
  email: text("email"),
  taxCode: text("tax_code"), // MST hoặc CCCD
  address: text("address"),
  // Tài khoản nhận tiền quyết toán
  bankName: text("bank_name"),
  bankAccountNo: text("bank_account_no"),
  bankAccountName: text("bank_account_name"),
  // Hợp đồng
  managementFeePct: numeric("management_fee_pct", { precision: 5, scale: 2, mode: "number" }), // null = dùng mức chung managementFeePct
  // CĐT đặc biệt (vd Uxistay) chịu thêm thuế trong quyết toán; null = không áp dụng
  vatPct: numeric("vat_pct", { precision: 5, scale: 2, mode: "number" }), // thuế GTGT, % doanh thu quyết toán
  pitPct: numeric("pit_pct", { precision: 5, scale: 2, mode: "number" }), // thuế TNCN, % lợi nhuận sau phí quản lý
  contractStartOn: day("contract_start_on"),
  contractEndOn: day("contract_end_on"),
  contractUrl: text("contract_url"),
  payoutDay: integer("payout_day"), // ngày chuyển tiền hằng tháng (1–28)
  active: boolean("active").notNull().default(true),
  note: text("note"),
  /** Webhook bot Lark của nhóm chat có chủ nhà: nhận tin nhắc duyệt chi phí. Trống = gửi nhóm Lark chung. */
  larkWebhookUrl: text("lark_webhook_url"),
  createdAt: ts("created_at").notNull().defaultNow(),
  /** @deprecated Đã chuyển sang dayladau_accounts (migration 0003). Không đọc/ghi; sẽ xóa ở migration sau. */
  dayladauHostId: text("dayladau_host_id"),
  /** @deprecated Như trên. */
  dayladauTokenEncrypted: text("dayladau_token_encrypted"),
});

/** Tài khoản Dayladau (host ID + access token) của NĐT. Mỗi cơ sở lấy đơn từ đúng 1 tài khoản; 1 tài khoản có thể dùng cho nhiều cơ sở. */
export const dayladauAccounts = pgTable("dayladau_accounts", {
  id: id(),
  investorId: text("investor_id").notNull().references(() => investors.id),
  label: text("label").notNull(), // vd "TK Hội An"
  hostId: text("host_id").notNull().unique(),
  tokenEncrypted: text("token_encrypted").notNull(), // AES-256-GCM, không bao giờ trả ra client
  tokenLast4: text("token_last4"), // để hiện "…abcd" mà không cần giải mã
  tokenUpdatedAt: ts("token_updated_at"),
  active: boolean("active").notNull().default(true), // false = tạm dừng đồng bộ
  lastSyncedAt: ts("last_synced_at"),
  lastSyncStatus: text("last_sync_status"), // OK | FAILED
  lastSyncError: text("last_sync_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const properties = pgTable("properties", {
  id: id(),
  investorId: text("investor_id").notNull().references(() => investors.id),
  dayladauAccountId: text("dayladau_account_id").references(() => dayladauAccounts.id), // null = chỉ nhập đơn tay
  name: text("name").notNull(),
  address: text("address"),
  investmentAmount: money("investment_amount"),
  investmentStartMonth: text("investment_start_month"),
  occupancyKpiPct: integer("occupancy_kpi_pct").notNull().default(70),
  variableCostPerNight: money("variable_cost_per_night"),
  fixedCostMonthly: money("fixed_cost_monthly"),
  /** Mã viết tắt trong nội dung chuyển khoản (vd "vp", "pkb") để gợi ý cơ sở khi đọc sao kê. */
  bankCodes: text("bank_codes").array().notNull().default(sql`'{}'::text[]`),
  active: boolean("active").notNull().default(true),
});

export const rooms = pgTable(
  "rooms",
  {
    id: id(),
    propertyId: text("property_id").notNull().references(() => properties.id),
    name: text("name").notNull(),
    // Listing Dayladau đang gắn: mã listing là duy nhất trong một tài khoản (tên listing có thể trùng giữa các tài khoản)
    dayladauAccountId: text("dayladau_account_id").references(() => dayladauAccounts.id),
    dayladauRoomId: text("dayladau_room_id"),
    openedOn: day("opened_on").notNull(),
    closedOn: day("closed_on"),
    revenueKpiMonthly: money("revenue_kpi_monthly"), // KPI doanh thu / tháng, 0 = chưa đặt
  },
  (t) => [uniqueIndex("rooms_dayladau_listing").on(t.dayladauAccountId, t.dayladauRoomId)],
);

// Listing phụ của phòng: listing cũ hoặc listing thứ hai của cùng một phòng trên Dayladau.
// Listing chính vẫn nằm ở rooms.dayladau_room_id. Một listing chỉ thuộc một phòng (chính hoặc phụ), kiểm tra ở lib/dayladau/room-listings.ts.
export const roomListings = pgTable(
  "room_listings",
  {
    roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
    dayladauAccountId: text("dayladau_account_id").notNull().references(() => dayladauAccounts.id),
    listingKey: text("listing_key").notNull(),
  },
  (t) => [primaryKey({ columns: [t.dayladauAccountId, t.listingKey] }), index("room_listings_room").on(t.roomId)],
);

export const userPropertyAccess = pgTable(
  "user_property_access",
  {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    propertyId: text("property_id").notNull().references(() => properties.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.userId, t.propertyId] })],
);

// ---------- 4.2 Doanh thu ----------
export const bookingSourceEnum = pgEnum("booking_source", ["DAYLADAU", "MANUAL"]);
export const bookingStatusEnum = pgEnum("booking_status", ["CONFIRMED", "CANCELLED"]);

export const bookings = pgTable(
  "bookings",
  {
    id: id(),
    source: bookingSourceEnum("source").notNull(),
    externalId: text("external_id").unique(),
    propertyId: text("property_id").notNull().references(() => properties.id),
    roomId: text("room_id").notNull().references(() => rooms.id),
    channel: text("channel").notNull(),
    guestName: text("guest_name"),
    bookedAt: day("booked_at"),
    checkIn: day("check_in").notNull(),
    checkOut: day("check_out").notNull(),
    grossAmount: money("gross_amount"),
    commissionAmount: money("commission_amount"),
    netAmount: money("net_amount"),
    status: bookingStatusEnum("status").notNull(),
    rentalType: text("rental_type"), // type_rental của Dayladau; null = thuê theo đêm
    transferProofUrl: text("transfer_proof_url"),
    rawPayload: jsonb("raw_payload"),
    createdById: text("created_by_id"),
    lastSyncedAt: ts("last_synced_at"),
  },
  (t) => [index("bookings_prop_checkin").on(t.propertyId, t.checkIn)],
);

export const nightKindEnum = pgEnum("night_kind", ["NIGHT", "HOURLY", "CANCEL_FEE"]);

export const bookingNights = pgTable(
  "booking_nights",
  {
    id: id(),
    bookingId: text("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
    propertyId: text("property_id").notNull(),
    roomId: text("room_id").notNull(),
    nightDate: day("night_date").notNull(),
    netAmount: money("net_amount"),
    kind: nightKindEnum("kind").notNull().default("NIGHT"), // chỉ NIGHT tính vào công suất
  },
  (t) => [uniqueIndex("nights_booking_date").on(t.bookingId, t.nightDate), index("nights_prop_date").on(t.propertyId, t.nightDate)],
);

export const bookingChangeLogs = pgTable("booking_change_logs", {
  id: id(),
  bookingId: text("booking_id").notNull().references(() => bookings.id, { onDelete: "cascade" }),
  changedAt: ts("changed_at").notNull().defaultNow(),
  changedBy: text("changed_by").notNull(), // "SYNC" hoặc userId
  reason: text("reason"),
  before: jsonb("before"),
  after: jsonb("after").notNull(),
});

export const reviews = pgTable("reviews", {
  id: id(),
  propertyId: text("property_id").notNull().references(() => properties.id),
  bookingId: text("booking_id"),
  channel: text("channel").notNull(),
  score: numeric("score", { precision: 4, scale: 2 }).notNull(), // thang 10
  reviewDate: day("review_date").notNull(),
  content: text("content"),
});

// ---------- 4.3 Chi phí ----------
export const costScopeEnum = pgEnum("cost_scope", ["DIRECT", "COMMON"]);
export const paymentStatusEnum = pgEnum("payment_status", ["UNPAID", "PAID"]);
/** Kế toán kê khai → PENDING; chủ đầu tư (chi phí chung: Admin) duyệt → APPROVED mới tính vào lãi lỗ. */
export const expenseApprovalEnum = pgEnum("expense_approval", ["PENDING", "APPROVED", "REJECTED"]);

export const expenseCategories = pgTable("expense_categories", {
  id: id(),
  name: text("name").notNull(),
  scope: costScopeEnum("scope").notNull(),
  active: boolean("active").notNull().default(true),
});

export const expenses = pgTable(
  "expenses",
  {
    id: id(),
    propertyId: text("property_id").references(() => properties.id), // null = chi phí chung
    categoryId: text("category_id").notNull().references(() => expenseCategories.id),
    month: text("month").notNull(),
    incurredOn: day("incurred_on").notNull(),
    amount: money("amount"),
    description: text("description").notNull(),
    paymentStatus: paymentStatusEnum("payment_status").notNull().default("UNPAID"),
    paidAt: ts("paid_at"),
    receiptUrls: text("receipt_urls").array().notNull().default(sql`'{}'::text[]`),
    taskId: text("task_id"),
    createdById: text("created_by_id").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    // Duyệt chi: chỉ APPROVED được ghi nhận vào quyết toán, báo cáo
    approvalStatus: expenseApprovalEnum("approval_status").notNull().default("PENDING"),
    approvedById: text("approved_by_id"),
    approvedAt: ts("approved_at"),
    rejectReason: text("reject_reason"),
    updatedById: text("updated_by_id"),
    updatedAt: ts("updated_at"),
    /** Dòng sao kê sinh ra khoản chi này (nếu ghi nhận từ sao kê). */
    bankTransactionId: text("bank_transaction_id").unique(),
  },
  (t) => [index("expenses_month_prop").on(t.month, t.propertyId), index("expenses_approval").on(t.approvalStatus)],
);

// ---------- Sao kê ngân hàng ----------
/** Một lần tải file sao kê lên. */
export const bankStatements = pgTable("bank_statements", {
  id: id(),
  bank: text("bank").notNull(), // "MB"
  accountNo: text("account_no").notNull(),
  accountName: text("account_name"),
  fromDate: day("from_date"),
  toDate: day("to_date"),
  openingBalance: bigint("opening_balance", { mode: "number" }),
  closingBalance: bigint("closing_balance", { mode: "number" }),
  fileName: text("file_name"),
  uploadedById: text("uploaded_by_id").notNull(),
  uploadedAt: ts("uploaded_at").notNull().defaultNow(),
});

/** NEW: tiền ra chưa phân loại · RECORDED: đã ghi nhận chi phí · IGNORED: không phải chi phí · INCOME: tiền vào */
export const bankTxnStatusEnum = pgEnum("bank_txn_status", ["NEW", "RECORDED", "IGNORED", "INCOME"]);

export const bankTransactions = pgTable(
  "bank_transactions",
  {
    id: id(),
    statementId: text("statement_id").notNull().references(() => bankStatements.id, { onDelete: "cascade" }),
    accountNo: text("account_no").notNull(),
    ref: text("ref").notNull(), // số bút toán, chống nhập trùng khi tải lại sao kê chồng kỳ
    txnAt: ts("txn_at").notNull(),
    bookedOn: day("booked_on").notNull(),
    debit: money("debit"), // tiền ra
    credit: money("credit"), // tiền vào
    balance: bigint("balance", { mode: "number" }),
    counterparty: text("counterparty"),
    content: text("content").notNull(),
    status: bankTxnStatusEnum("status").notNull(),
    note: text("note"), // lý do bỏ qua
    handledById: text("handled_by_id"),
    handledAt: ts("handled_at"),
  },
  (t) => [uniqueIndex("bank_txn_ref").on(t.accountNo, t.ref), index("bank_txn_status").on(t.status, t.bookedOn)],
);

export const monthPeriods = pgTable("month_periods", {
  month: text("month").primaryKey(),
  commonCostsFinalized: boolean("common_costs_finalized").notNull().default(false),
});

// ---------- 4.4 Quyết toán ----------
export const settlementStatusEnum = pgEnum("settlement_status", ["DRAFT", "LOCKED"]);

export const settlements = pgTable(
  "settlements",
  {
    id: id(),
    investorId: text("investor_id").notNull().references(() => investors.id),
    month: text("month").notNull(),
    status: settlementStatusEnum("status").notNull(),
    totalRevenue: money("total_revenue"),
    totalDirectCost: money("total_direct_cost"),
    totalCommonCost: money("total_common_cost"),
    totalProfit: money("total_profit"),
    managementFee: money("management_fee"),
    feePct: numeric("fee_pct", { precision: 5, scale: 2, mode: "number" }), // mức phí lúc khóa sổ; null = khóa trước khi có cột này
    investorNet: money("investor_net"),
    // Thuế của CĐT đặc biệt lúc khóa sổ (0 = không áp dụng)
    vatPct: numeric("vat_pct", { precision: 5, scale: 2, mode: "number" }),
    vatAmount: money("vat_amount"),
    pitPct: numeric("pit_pct", { precision: 5, scale: 2, mode: "number" }),
    pitAmount: money("pit_amount"),
    lockedAt: ts("locked_at"),
    lockedById: text("locked_by_id"),
  },
  (t) => [uniqueIndex("settlements_inv_month").on(t.investorId, t.month)],
);

export const settlementLines = pgTable("settlement_lines", {
  id: id(),
  settlementId: text("settlement_id").notNull().references(() => settlements.id, { onDelete: "cascade" }),
  propertyId: text("property_id").notNull(),
  roomCount: integer("room_count").notNull(),
  soldNights: integer("sold_nights").notNull(),
  availableNights: integer("available_nights").notNull(),
  revenue: money("revenue"),
  adjustments: money("adjustments"),
  directCost: money("direct_cost"),
  commonCostAlloc: money("common_cost_alloc"),
  profit: money("profit"),
});

export const settlementUnlockLogs = pgTable("settlement_unlock_logs", {
  id: id(),
  settlementId: text("settlement_id").notNull().references(() => settlements.id, { onDelete: "cascade" }),
  at: ts("at").notNull().defaultNow(),
  byUserId: text("by_user_id").notNull(),
  reason: text("reason").notNull(),
});

export const adjustments = pgTable(
  "adjustments",
  {
    id: id(),
    propertyId: text("property_id").notNull(),
    appliedMonth: text("applied_month").notNull(),
    originalMonth: text("original_month").notNull(),
    bookingId: text("booking_id"),
    amount: money("amount"),
    reason: text("reason").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
  },
  (t) => [index("adj_prop_month").on(t.propertyId, t.appliedMonth)],
);

// ---------- 4.5 Công việc ----------
export const taskTypeEnum = pgEnum("task_type", ["CLEANING", "CHECKIN", "CHECKOUT", "MAINTENANCE", "PURCHASE", "BAD_REVIEW", "INVENTORY", "RECURRING"]);
export const taskStatusEnum = pgEnum("task_status", ["TODO", "IN_PROGRESS", "DONE", "CANCELLED"]);
export const priorityEnum = pgEnum("priority", ["LOW", "MEDIUM", "HIGH", "URGENT"]);

export const tasks = pgTable(
  "tasks",
  {
    id: id(),
    propertyId: text("property_id").notNull().references(() => properties.id),
    roomId: text("room_id"),
    bookingId: text("booking_id"),
    type: taskTypeEnum("type").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    assignedById: text("assigned_by_id").notNull(),
    assigneeId: text("assignee_id").references(() => users.id),
    dueAt: ts("due_at").notNull(),
    priority: priorityEnum("priority").notNull().default("MEDIUM"),
    status: taskStatusEnum("status").notNull().default("TODO"),
    completedAt: ts("completed_at"),
    photoUrls: text("photo_urls").array().notNull().default(sql`'{}'::text[]`),
    recurrenceRule: text("recurrence_rule"),
    templateId: text("template_id"),
  },
  (t) => [index("tasks_prop_status_due").on(t.propertyId, t.status, t.dueAt)],
);

export const checklistTemplates = pgTable("checklist_templates", {
  id: id(),
  name: text("name").notNull(),
  items: text("items").array().notNull(),
});

export const checklistResults = pgTable("checklist_results", {
  id: id(),
  taskId: text("task_id").notNull().unique().references(() => tasks.id, { onDelete: "cascade" }),
  results: jsonb("results").notNull(), // [{ item, done, note }]
});

export const attendance = pgTable(
  "attendance",
  {
    id: id(),
    userId: text("user_id").notNull().references(() => users.id),
    propertyId: text("property_id").notNull(),
    date: day("date").notNull(),
    checkInAt: ts("check_in_at").notNull(),
    checkOutAt: ts("check_out_at"),
    photoUrl: text("photo_url"),
  },
  (t) => [uniqueIndex("attendance_user_date").on(t.userId, t.date)],
);

// ---------- 4.6 Cấu hình và cảnh báo ----------
export const settings = pgTable("settings", {
  key: text("key").primaryKey(), // managementFeePct, commission.Airbnb, syncCron, larkWebhookUrl, ...
  value: text("value").notNull(),
});

export const alerts = pgTable("alerts", {
  id: id(),
  type: text("type").notNull(), // LOW_OCCUPANCY, TASK_OVERDUE, SYNC_FAILED, UNMAPPED_ROOM, LOCKED_MONTH_CHANGED
  key: text("key").notNull().unique(), // chống tạo trùng cảnh báo đang mở
  propertyId: text("property_id"),
  month: text("month"),
  message: text("message").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
  resolvedAt: ts("resolved_at"),
});

export const syncRuns = pgTable("sync_runs", {
  id: id(),
  startedAt: ts("started_at").notNull().defaultNow(),
  finishedAt: ts("finished_at"),
  created: integer("created").notNull().default(0),
  updated: integer("updated").notNull().default(0),
  skipped: integer("skipped").notNull().default(0),
  errors: jsonb("errors"),
});

// ---------- 4.7 Payout Airbnb từ Gmail ----------
// Mỗi NĐT kết nối Gmail nhận email payout của tài khoản Airbnb. Chỉ đọc (gmail.readonly).

export const gmailAccounts = pgTable("gmail_accounts", {
  id: id(),
  investorId: text("investor_id").notNull().references(() => investors.id),
  email: text("email").notNull().unique(),
  refreshTokenEncrypted: text("refresh_token_encrypted").notNull(), // AES-256-GCM, không bao giờ trả ra client
  connectedById: text("connected_by_id"),
  active: boolean("active").notNull().default(true),
  lastSyncedAt: ts("last_synced_at"),
  lastSyncStatus: text("last_sync_status"), // OK | FAILED
  lastSyncError: text("last_sync_error"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const payoutParseEnum = pgEnum("payout_parse_status", ["OK", "PARTIAL", "FAILED"]);

/** Một email payout = một lần Airbnb chuyển tiền (có thể gộp nhiều đơn). */
export const airbnbPayouts = pgTable(
  "airbnb_payouts",
  {
    id: id(),
    gmailAccountId: text("gmail_account_id").references(() => gmailAccounts.id), // null = email dán tay trên web
    investorId: text("investor_id").notNull().references(() => investors.id),
    gmailMessageId: text("gmail_message_id").notNull(), // email dán tay: "paste:" + mã băm nội dung
    receivedAt: ts("received_at").notNull(),
    payoutDate: day("payout_date").notNull(), // ngày gửi tiền (theo email), giờ VN
    amount: money("amount"), // tổng tiền chuyển, VND
    currency: text("currency").notNull().default("VND"),
    payoutCode: text("payout_code"), // "Mã khoản chi trả" / Payout ID: Airbnb có khi gửi lặp cùng một khoản
    totalUsd: numeric("total_usd", { precision: 14, scale: 2, mode: "number" }), // tổng USD các dòng
    exchangeRate: numeric("exchange_rate", { precision: 14, scale: 4, mode: "number" }), // VNĐ/USD của email
    subject: text("subject"),
    bodyText: text("body_text"), // nội dung đã bỏ HTML, giữ lại để tách lại khi đổi bộ tách
    parseStatus: payoutParseEnum("parse_status").notNull(),
    parseNote: text("parse_note"),
  },
  (t) => [uniqueIndex("payouts_account_msg").on(t.gmailAccountId, t.gmailMessageId), index("payouts_inv_date").on(t.investorId, t.payoutDate), index("payouts_inv_code").on(t.investorId, t.payoutCode)],
);

export const payoutMatchEnum = pgEnum("payout_match_status", ["MATCHED", "AMOUNT_DIFF", "NOT_FOUND"]);

/**
 * Từng dòng giao dịch trong một email payout (một đơn thường có dòng tiền phòng + các dòng thuế khấu trừ âm),
 * khớp với bookings theo mã đặt phòng. Trạng thái khớp và số lệch tính cho cả đơn, ghi giống nhau trên mọi dòng của đơn.
 */
export const airbnbPayoutItems = pgTable(
  "airbnb_payout_items",
  {
    id: id(),
    payoutId: text("payout_id").notNull().references(() => airbnbPayouts.id, { onDelete: "cascade" }),
    confirmationCode: text("confirmation_code"),
    guestName: text("guest_name"),
    lineType: text("line_type"), // Tiền phòng, Thuế TNCN, Thuế VAT, Phí dọn dẹp…
    listingName: text("listing_name"),
    listingId: text("listing_id"), // ID listing Airbnb
    usdAmount: numeric("usd_amount", { precision: 14, scale: 2, mode: "number" }),
    checkIn: day("check_in"),
    checkOut: day("check_out"),
    amount: bigint("amount", { mode: "number" }), // VNĐ phân bổ theo tỷ giá của email; null = email không có tổng VNĐ
    bookingId: text("booking_id").references(() => bookings.id, { onDelete: "set null" }),
    matchStatus: payoutMatchEnum("match_status").notNull().default("NOT_FOUND"),
    diffAmount: bigint("diff_amount", { mode: "number" }), // cả đơn: VNĐ sau thuế Airbnb đã chuyển (mọi email) − thực nhận trong hệ thống
  },
  (t) => [index("payout_items_payout").on(t.payoutId), index("payout_items_code").on(t.confirmationCode), index("payout_items_booking").on(t.bookingId)],
);

/**
 * Phòng gán tay cho một listing Airbnb trong email payout, dùng khi dòng payout chưa khớp được đơn nào.
 * Gán theo listing nên áp dụng cho mọi payout (cũ và mới) của listing đó. Đơn đã khớp vẫn lấy phòng của đơn.
 */
export const airbnbListingRooms = pgTable(
  "airbnb_listing_rooms",
  {
    investorId: text("investor_id").notNull().references(() => investors.id),
    listingKey: text("listing_key").notNull(), // ID listing Airbnb; email không có ID thì là tên listing
    roomId: text("room_id").notNull().references(() => rooms.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.investorId, t.listingKey] })],
);
