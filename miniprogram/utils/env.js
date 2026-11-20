/**
 * 当前是否开发版（含微信开发者工具）。
 * 调试入口、耗时明细这类只给开发者看的东西用它控制；体验版 / 正式版一律隐藏。
 */
function isDevBuild() {
  try {
    const info = wx.getAccountInfoSync && wx.getAccountInfoSync()
    return !info || !info.miniProgram || info.miniProgram.envVersion === 'develop'
  } catch (e) {
    return false
  }
}

module.exports = { isDevBuild }
