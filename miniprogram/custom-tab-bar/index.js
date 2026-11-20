const cache = require('../services/storage-cache')
const nav = require('../utils/navigate')

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
    hidden: false
  },
  methods: {
    setHidden(hidden) {
      this.setData({ hidden: !!hidden })
    },
    onSwitch(e) {
      const { path, index } = e.currentTarget.dataset
      const next = Number(index)
      if (this.data.selected === next) return
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
