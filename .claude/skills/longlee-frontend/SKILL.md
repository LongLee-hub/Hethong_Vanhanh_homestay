---
name: longlee-frontend
description: Bộ skill frontend của LongLee cho LOCI Homestay Manager. Dùng trước khi dựng hoặc sửa bất kỳ giao diện nào — trang, layout, component React/Next.js, CSS, bản prototype — để chọn đúng skill trong nhóm airbnb-ui-skills, host-hub-design, frontend-patterns, frontend-design.
---

# LongLee-frontend

Skill này không chứa quy tắc thiết kế riêng. Nó chọn skill frontend phù hợp với việc đang làm rồi gọi skill đó.

## Phạm vi

Mọi việc liên quan đến giao diện: trang và layout trong `app/`, component trong `components/`, CSS trong `app/globals.css`, và bản chạy thử trong `prototype/`.

## Các skill trong nhóm

| Skill | Dùng khi |
| --- | --- |
| `airbnb-ui-skills` | Dựng UI theo design system kiểu Airbnb (light mode, Inter, 4px grid) |
| `host-hub-design` | Style trang host theo Airbnb host-hub (greeting, stat strip, pill-tab…) |
| `frontend-patterns` | Pattern React/Next.js — state management, performance, UI |
| `frontend-design` | Dựng giao diện frontend chất lượng cao, tránh "AI aesthetic" |

## Cách làm

1. Xác định việc đang làm thuộc loại nào trong bảng. Một việc có thể khớp nhiều skill.
2. Gọi từng skill khớp bằng Skill tool trước khi viết mã, rồi làm theo hướng dẫn của skill đó.
3. Đọc mã giao diện đang có (`app/globals.css`, các component trong `components/`) và giữ nhất quán với nó.

## Cách chọn

- Trang dành cho host (tổng quan, danh sách căn, quyết toán): `host-hub-design` cho bố cục, `airbnb-ui-skills` cho màu, chữ và khoảng cách.
- Component mới hoặc màn hình chưa có mẫu: `airbnb-ui-skills` trước, rồi `frontend-design` để rà lại chất lượng hình ảnh.
- Việc thuần logic giao diện (state, data fetching, tối ưu render, tách component): `frontend-patterns`.
- Khi hai skill mâu thuẫn về hình ảnh, ưu tiên `airbnb-ui-skills` để toàn bộ app giữ một design system.

## Nếu skill chưa được cài

Nếu một skill trong bảng không có trong danh sách skill của phiên làm việc, nói rõ skill nào thiếu rồi làm tiếp theo đúng mô tả ở cột "Dùng khi". Không tự bịa nội dung của skill đó.
