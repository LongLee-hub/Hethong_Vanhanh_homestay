// Loại cảnh báo do đồng bộ Dayladau sinh ra. Không import gì để trang phía trình duyệt dùng được.

/** Cảnh báo đồng bộ không tự đóng; Admin bấm "Đã xem" để đóng. UNMAPPED_ROOM không đóng tay vì đóng rồi sẽ không báo lại. */
export const DISMISSIBLE_ALERTS = ["SYNC_FAILED", "BOOKING_MISSING", "LOCKED_MONTH_CHANGED"];
