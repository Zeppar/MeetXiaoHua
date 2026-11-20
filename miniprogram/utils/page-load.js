/**
 * 本地读盘通常 <10ms。只有超过阈值才展示猫爪 loading，避免「假慢」。
 */
const SLOW_MS = 180

function run(page, task) {
  if (!page || typeof page.setData !== 'function') {
    return Promise.resolve().then(task)
  }

  let shown = false
  const timer = setTimeout(() => {
    if (page.__mxhUnloaded) return
    shown = true
    try {
      page.setData({ pageLoading: true })
    } catch (e) {
      /* ignore */
    }
  }, SLOW_MS)

  return Promise.resolve()
    .then(task)
    .finally(() => {
      clearTimeout(timer)
      if (!shown) return
      if (page.__mxhUnloaded) return
      try {
        page.setData({ pageLoading: false })
      } catch (e) {
        /* ignore */
      }
    })
}

module.exports = { run, SLOW_MS }
