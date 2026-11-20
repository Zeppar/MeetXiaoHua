/** 旧入口：设置已并入出门记录页 */
Page({
  onShow() {
    wx.redirectTo({
      url: '/pages/visit-log/visit-log',
      fail: () => {
        wx.navigateTo({ url: '/pages/visit-log/visit-log' })
      }
    })
  }
})
