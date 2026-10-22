#!/usr/bin/env bash
# Cập nhật bản mới lên VPS: lấy mã mới, build, chạy migration, khởi động lại app.
# Chạy bằng người dùng loci:  bash ~/app/deploy/deploy.sh
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f .env ] || { echo "Chưa có file .env, copy từ .env.example rồi điền giá trị"; exit 1; }

git pull --ff-only
npm ci
node --env-file=.env node_modules/drizzle-kit/bin.cjs migrate   # cần DATABASE_URL trong .env
npm run build

pm2 startOrReload deploy/ecosystem.config.cjs --update-env
pm2 save
pm2 status loci
