/**
 * 将精确坐标模糊到街区/城镇级别（约 0.01 度 ≈ 1km）
 */
function blurCoordinate(lat, lng) {
  const blur = (v) => Math.round(Number(v) * 100) / 100
  return {
    lat: blur(lat),
    lng: blur(lng)
  }
}

/** 兼容 lat/lng、latitude/longitude，以及云端偶发字符串数字 */
function normalizeGeo(geo) {
  if (!geo || typeof geo !== 'object') return null
  const lat = Number(geo.lat != null ? geo.lat : geo.latitude)
  const lng = Number(geo.lng != null ? geo.lng : geo.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

function isValidGeo(geo) {
  return !!normalizeGeo(geo)
}

/**
 * 在基准点附近散开，便于放大后能拆开；缩小时仍由聚合收成气泡
 * 半径约 500m~1.8km
 */
function spreadFootprints(lat, lng, index, total) {
  const baseLat = Number(lat)
  const baseLng = Number(lng)
  if (!Number.isFinite(baseLat) || !Number.isFinite(baseLng)) return null
  const n = Math.max(1, Number(total) || 1)
  const i = Math.max(0, Number(index) || 0)
  if (n <= 1) {
    return { lat: baseLat, lng: baseLng }
  }
  const angle = (2 * Math.PI * i) / n - Math.PI / 2
  const ring = Math.floor(i / 8)
  const radius = 0.005 + (i % 5) * 0.0014 + ring * 0.0028
  return {
    lat: Math.round((baseLat + Math.cos(angle) * radius) * 1e5) / 1e5,
    lng: Math.round((baseLng + Math.sin(angle) * radius) * 1e5) / 1e5
  }
}

/** 按模糊街区归组（与 blurCoordinate 同精度） */
function geoCellKey(lat, lng) {
  const g = blurCoordinate(lat, lng)
  return `${g.lat},${g.lng}`
}

function getCurrentPosition(timeoutMs = 8000) {
  return new Promise((resolve) => {
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), Math.max(1000, Number(timeoutMs) || 8000))
    wx.getLocation({
      type: 'gcj02',
      isHighAccuracy: false,
      success: (res) => {
        clearTimeout(timer)
        const lat = Number(res.latitude)
        const lng = Number(res.longitude)
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
          finish(null)
          return
        }
        finish({ latitude: lat, longitude: lng })
      },
      fail: () => {
        clearTimeout(timer)
        finish(null)
      }
    })
  })
}

/**
 * 将有坐标的卡牌归一化到 0~1 画布坐标
 */
function normalizeToCanvas(cards) {
  const withGeo = cards.filter((c) => c.geo && typeof c.geo.lat === 'number')
  if (!withGeo.length) return []

  const lats = withGeo.map((c) => c.geo.lat)
  const lngs = withGeo.map((c) => c.geo.lng)
  let minLat = Math.min(...lats)
  let maxLat = Math.max(...lats)
  let minLng = Math.min(...lngs)
  let maxLng = Math.max(...lngs)

  // 单点或极近时给一点跨度，避免全叠在中心
  if (maxLat - minLat < 0.02) {
    minLat -= 0.01
    maxLat += 0.01
  }
  if (maxLng - minLng < 0.02) {
    minLng -= 0.01
    maxLng += 0.01
  }

  return withGeo.map((c) => {
    const x = (c.geo.lng - minLng) / (maxLng - minLng)
    const y = 1 - (c.geo.lat - minLat) / (maxLat - minLat)
    return {
      ...c,
      canvasX: 0.08 + x * 0.84,
      canvasY: 0.08 + y * 0.84
    }
  })
}

module.exports = {
  blurCoordinate,
  normalizeGeo,
  isValidGeo,
  spreadFootprints,
  geoCellKey,
  getCurrentPosition,
  normalizeToCanvas
}
