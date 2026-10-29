// PM2 giữ app chạy nền, tự bật lại khi lỗi hoặc khi VPS khởi động lại.
// Chỉ chạy 1 tiến trình: lib/scheduler.ts hẹn giờ đồng bộ trong app, chạy 2 bản sẽ đồng bộ 2 lần.
module.exports = {
  apps: [
    {
      name: "loci",
      cwd: __dirname + "/..",
      script: "node_modules/next/dist/bin/next",
      args: "start -p 3000 -H 127.0.0.1", // chỉ nghe nội bộ, Caddy đứng trước nhận HTTPS
      instances: 1,
      exec_mode: "fork",
      env: { NODE_ENV: "production", TZ: "Asia/Ho_Chi_Minh", AUTO_SYNC_MINUTES: "30" },
      max_memory_restart: "800M",
      time: true,
    },
  ],
};
