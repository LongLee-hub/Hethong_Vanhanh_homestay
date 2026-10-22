#!/usr/bin/env bash
# Cài VPS lần đầu (Ubuntu 22.04 / 24.04). Chạy bằng root:
#   bash setup-vps.sh app.tenmien.vn
# Sau đó làm tiếp theo mục "Server riêng (VPS)" trong README.
set -euo pipefail

DOMAIN="${1:?Thiếu tên miền, ví dụ: bash setup-vps.sh app.tenmien.vn}"
REPO="${REPO:-https://github.com/LongLee-hub/Hethong_Vanhanh_homestay.git}"
APP_USER=loci
APP_DIR=/home/$APP_USER/app

timedatectl set-timezone Asia/Ho_Chi_Minh
apt-get update
apt-get install -y curl git ufw debian-keyring debian-archive-keyring apt-transport-https gnupg

# Node.js 22 LTS
curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
apt-get install -y nodejs
npm install -g pm2

# Caddy (HTTPS tự động)
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/gpg.key | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt > /etc/apt/sources.list.d/caddy-stable.list
apt-get update
apt-get install -y caddy

# Tường lửa: chỉ mở SSH và web
ufw allow OpenSSH
ufw allow 80,443/tcp
ufw --force enable

# Người dùng riêng chạy app (không chạy bằng root)
id -u $APP_USER >/dev/null 2>&1 || adduser --disabled-password --gecos "" $APP_USER
[ -d "$APP_DIR" ] || sudo -u $APP_USER git clone "$REPO" "$APP_DIR"

sed "s/app.example.com/$DOMAIN/" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
systemctl reload caddy

# PM2 tự bật app khi VPS khởi động lại
env PATH="$PATH" pm2 startup systemd -u $APP_USER --hp /home/$APP_USER

echo
echo "Xong phần hệ thống. Việc tiếp theo:"
echo "  1. Tạo file $APP_DIR/.env (copy từ .env.example, điền giá trị như trên Vercel)"
echo "  2. sudo -u $APP_USER bash $APP_DIR/deploy/deploy.sh"
