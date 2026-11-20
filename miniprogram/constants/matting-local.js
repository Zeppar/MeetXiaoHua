/**
 * 本机 rembg 连接参数（仅开发者工具）
 * 拍照页选「rembg」或「精抠」时走这里
 * 需本机 7000/7001 在跑，并勾选不校验合法域名
 */
module.exports = {
  BASE_URL: 'http://127.0.0.1:7001',
  // rembg 2.x 没有 u2net_animal；u2net 通用、u2netp 更快边缘稍粗
  MODEL: 'u2net',
  // alpha matting 在 CPU 上很慢，且对「整脚切掉」帮助有限 → 关掉提速
  ALPHA: false,
  WHITE_BORDER: true
}
