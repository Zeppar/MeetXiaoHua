const cache = require('../services/storage-cache')
const nav = require('../utils/navigate')
const onboarding = require('../utils/onboarding')

function currentPage() {
  const pages = getCurrentPages()
  return pages[pages.length - 1]
}

function currentRoute() {
  const page = currentPage()
  return (page && page.route) || ''
}

Component({
  data: {
    selected: 0,
    hidden: false,
    /** 有 2 只猫前小屋上锁，新手先专心拍猫 */
    roomLocked: false
  },
  lifetimes: {
    attached() {
      this.refreshLock()
    }
  },
  pageLifetimes: {
    show() {
      this.refreshLock()
    }
  },
  methods: {
    refreshLock(cardCount) {
      const roomLocked = !onboarding.isRoomUnlocked(cardCount)
      if (roomLocked !== this.data.roomLocked) this.setData({ roomLocked })
    },
    setHidden(hidden) {
      this.setData({ hidden: !!hidden })
    },
    onSwitch(e) {
      const { path, index } = e.currentTarget.dataset
      const next = Number(index)
      if (this.data.selected === next) return
      if (next === 2 && this.data.roomLocked) {
        wx.showToast({ title: '再遇见一只猫，就能给它们一个家', icon: 'none' })
        return
      }
      const route = String(path || '').replace(/^\//, '')
      if (currentRoute() === route) {
        this.setData({ selected: next })
        return
      }
      this.setData({ selected: next })
      nav.switchTab(currentPage(), path)
    },
    onShoot() {
      const page = currentPage()
      if (!cache.isPrivacyAgreed()) {
        if (currentRoute() !== 'pages/home/home') {
          nav.switchTab(page, '/pages/home/home')
        }
        return
      }
      nav.navigateTo(page, '/pages/camera/camera')
    }
  }
})
