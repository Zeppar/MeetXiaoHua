/**
 * 页面跳转。本地数据本身很快，不再套一层源页 loading，
 * 否则会把「按需注入 / 路由动画」硬生生拖成可见等待。
 */

function navigateTo(_page, url) {
  wx.navigateTo({ url })
}

function switchTab(_page, url) {
  wx.switchTab({ url })
}

function redirectTo(_page, url) {
  wx.redirectTo({ url })
}

module.exports = {
  navigateTo,
  switchTab,
  redirectTo
}
