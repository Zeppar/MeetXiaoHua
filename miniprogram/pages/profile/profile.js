const api = require('../../services/api')
const copy = require('../../constants/copy')
const nav = require('../../utils/navigate')

Page({
  data: {
    nickName: '猫友',
    avatarLetter: '猫',
    stats: {
      cardCount: 0,
      breedCount: 0,
      memoryCount: 0
    },
    pageLoading: false,
    loadingText: copy.tips.pageLoading
  },

  onUnload() {
    this.__mxhUnloaded = true
  },

  onShow() {
    if (typeof this.getTabBar === 'function' && this.getTabBar()) {
      this.getTabBar().setData({ selected: 3 })
    }
    this.load()
  },

  async load() {
    const { user } = await api.getProfile()
    if (!user) return
    const nick = user.nickName || '猫友'
    this.setData({
      nickName: nick,
      avatarLetter: nick.slice(0, 1),
      stats: user.stats || { cardCount: 0, breedCount: 0, memoryCount: 0 }
    })
  },

  onBreedReview() {
    nav.navigateTo(this, '/pages/breed-review/breed-review')
  },

  onVisitLog() {
    nav.navigateTo(this, '/pages/visit-log/visit-log')
  },

  onReleased() {
    nav.navigateTo(this, '/pages/released/released')
  },

  onPrivacy() {
    nav.navigateTo(this, '/pages/privacy/privacy')
  },

  onAbout() {
    nav.navigateTo(this, '/pages/about/about')
  }
})
