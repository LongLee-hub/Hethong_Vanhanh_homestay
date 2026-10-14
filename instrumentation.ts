// Next.js gọi register() một lần khi máy chủ khởi động.
export async function register() {
  // Phải viết dạng if (=== "nodejs") { import } để bản edge không kéo theo node:crypto
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { startScheduler } = await import("./lib/scheduler");
    startScheduler();
  }
}
