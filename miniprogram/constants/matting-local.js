/**
 * 本机 rembg 连接参数（仅开发者工具）
 * 拍照页选「rembg」或「精抠」时走这里
 * 需本机 7000/7001 在跑，并勾选不校验合法域名
 */
module.exports = {
  BASE_URL: 'http://127.0.0.1:7001',
  // animal 对猫更贴；脚仍可能被模型当背景（爪/地面色近），属模型局限非框裁切
  MODEL: 'u2net_animal',
  // alpha matting 在 CPU 上很慢，且对「整脚切掉」帮助有限 → 关掉提速
  ALPHA: false,
  WHITE_BORDER: true
}
