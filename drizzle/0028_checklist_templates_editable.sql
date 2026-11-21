-- Checklist dọn phòng sửa được trên web: thêm, bớt, sửa, xoá mục và ảnh mẫu cho từng mục.
-- Một mẫu mặc định (property_id null) cho mọi cơ sở; cơ sở nào cần khác thì có mẫu riêng.
ALTER TABLE "checklist_templates" ALTER COLUMN "items" SET DEFAULT '{}'::text[];--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD COLUMN IF NOT EXISTS "type" text DEFAULT 'CLEANING' NOT NULL;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD COLUMN IF NOT EXISTS "property_id" text;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD COLUMN IF NOT EXISTS "steps" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD COLUMN IF NOT EXISTS "updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "checklist_templates" ADD COLUMN IF NOT EXISTS "updated_by_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "checklist_templates_type_property" ON "checklist_templates" ("type", COALESCE("property_id", ''));
