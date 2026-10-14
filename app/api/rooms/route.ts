// API quản lý phòng: CRUD, chuyển cơ sở, đóng/mở.
import { z } from "zod";
import { getDb } from "@/lib/db";
import { requirePermission } from "@/lib/auth/access";
import { createRoom, updateRoom, transferRoom, closeRoom, reopenRoom, roomsOfProperty } from "@/lib/services/rooms";
import { api } from "@/lib/server";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Ngày phải có dạng YYYY-MM-DD");

// GET /api/rooms?propertyId=xxx — danh sách phòng theo cơ sở
export const GET = api(async ({ user, req }) => {
  const propertyId = new URL(req.url).searchParams.get("propertyId");
  if (!propertyId) return { error: "Thiếu propertyId" };
  return roomsOfProperty(getDb(), user, propertyId);
});

const CreateSchema = z.object({
  propertyId: z.string().min(1),
  name: z.string().min(1, "Nhập tên phòng"),
  dayladauRoomId: z.string().nullable().optional(),
  openedOn: isoDate,
});

const UpdateSchema = z.object({
  roomId: z.string().min(1),
  name: z.string().min(1).optional(),
  dayladauRoomId: z.string().nullable().optional(),
});

const TransferSchema = z.object({
  roomId: z.string().min(1),
  targetPropertyId: z.string().min(1),
});

const CloseSchema = z.object({
  roomId: z.string().min(1),
  closedOn: isoDate,
});

const ReopenSchema = z.object({
  roomId: z.string().min(1),
});

// POST /api/rooms — tạo/sửa/chuyển/đóng/mở phòng
// Body: { action: "create" | "update" | "transfer" | "close" | "reopen", ...data }
export const POST = api(async ({ user, req }) => {
  const body = await req.json();
  const action = body.action;
  const db = getDb();

  switch (action) {
    case "create":
      return createRoom(db, user, CreateSchema.parse(body));
    case "update": {
      const { roomId, ...input } = UpdateSchema.parse(body);
      return updateRoom(db, user, roomId, input);
    }
    case "transfer":
      return transferRoom(db, user, TransferSchema.parse(body));
    case "close":
      return closeRoom(db, user, body.roomId, CloseSchema.parse(body).closedOn);
    case "reopen":
      return reopenRoom(db, user, ReopenSchema.parse(body).roomId);
    default:
      return { error: "Action không hợp lệ. Dùng: create, update, transfer, close, reopen" };
  }
});
