// Email payout Airbnb dạng text/plain (như msg.getPlainBody() của Apps Script), dùng chung cho các test.

export const SAMPLE_VI = [
  "Airbnb",
  "Chúng tôi đã gửi cho bạn một khoản chi trả",
  "Chi tiết",
  "Nguyen Van An  $80,00 USD",
  "Nơi lưu trú • 3/10/2026 - 5/10/2026",
  "NTG402@Oldquarter/Studio/Balcony (1234567890123456)",
  "HMABCD1234",
  "Nguyen Van An  -$4,00 USD",
  "vn_income_tax_withholding • 3/10/2026 - 5/10/2026",
  "NTG402@Oldquarter/Studio/Balcony (1234567890123456)",
  "HMABCD1234",
  "Nguyen Van An  -$2,00 USD",
  "vn_vat_withholding • 3/10/2026 - 5/10/2026",
  "NTG402@Oldquarter/Studio/Balcony (1234567890123456)",
  "HMABCD1234",
  "John Smith",
  "$20,30 USD",
  "Nơi lưu trú • 10/30/2026 - 11/02/2026",
  "Unix76NTG401. Máy chiếu (9876543210)",
  "HMXYZ98765",
  "Tổng số tiền đã chi trả: ₫2.335.042 VND",
  "Mã khoản chi trả",
  "ABCDEF123456",
].join("\n");

export const SAMPLE_PASTE = [
  "Chi tiết",
  "Le Thi C  $32,00 USD",
  "Nơi lưu trú • 10/10/2026 - 11/10/2026",
  "VP101@Van Phuc (5555555555)",
  "HMPASTE001",
  "Tổng số tiền đã chi trả: ₫800.000 VND",
  "Mã khoản chi trả: PASTECODE0001",
].join("\r\n");
