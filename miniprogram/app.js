const api = require('./services/api')
const cache = require('./services/storage-cache')

App({
  globalData: {
    user: null,
    openid: '',
    cloudReady: false,
    privacyAgreed: false
  },

  onLaunch() {
    this.globalData.privacyAgreed = cache.isPrivacyAgreed()

    // 云开发环境 ID：开通后填入；空则本地模式（识别也会跳过腾讯云）
    // 腾讯云宠物识别密钥配在云函数环境变量，见 cloudfunctions/api/env.example.txt
    const envId = 'cloud1-d8g5xxemg89fef2db'
    if (wx.cloud && envId) {
      try {
        wx.cloud.init({
          env: envId,
          traceUser: true
        })
        this.globalData.cloudReady = true
        api.setCloudEnabled(true)
      } catch (e) {
        console.warn('cloud init failed, use local store', e)
        api.setCloudEnabled(false)
      }
    } else {
      api.setCloudEnabled(false)
    }

    this.bootstrap()
  },

  async bootstrap() {
    try {
      const res = await api.login()
      this.globalData.user = res.user
      this.globalData.openid = res.openid || (res.user && res.user._openid) || ''
    } catch (e) {
      console.warn('login fail', e)
      this.globalData.user = cache.getCachedUser()
    }
  },

  async refreshUser() {
    const res = await api.getProfile()
    this.globalData.user = res.user
    return res.user
  }
})
