/**
 * 足迹地图聚合：屏幕上会重叠的点收成一个气泡，只留数量角标
 * 用单链接（簇间任两点够近就合并），避免「两两成对后仍叠在一起」
 */

function thresholdForScale(scale, latitude) {
  const s = Math.max(3, Math.min(20, Number(scale) || 13))
  const lat = Number(latitude)
  const cosLat = Math.cos(((Number.isFinite(lat) ? lat : 31) * Math.PI) / 180)
  const metersPerPixel =
    (156543.03392 * Math.max(0.2, Math.abs(cosLat))) / Math.pow(2, s)
  // 按猫标尺寸 + 余量：视觉上挨着/压着就并
  const mergePx = 160
  const meters = metersPerPixel * mergePx * 2.6
  return Math.max(meters / 111320, 1e-7)
}

function dist(aLat, aLng, bLat, bLng) {
  const midLat = (((aLat + bLat) / 2) * Math.PI) / 180
  const dLat = aLat - bLat
  const dLng = (aLng - bLng) * Math.cos(midLat)
  return Math.sqrt(dLat * dLat + dLng * dLng)
}

function minDistBetweenClusters(a, b) {
  let min = Infinity
  for (let i = 0; i < a.cards.length; i++) {
    const ga = a.cards[i].geo
    for (let j = 0; j < b.cards.length; j++) {
      const gb = b.cards[j].geo
      const d = dist(ga.lat, ga.lng, gb.lat, gb.lng)
      if (d < min) min = d
    }
  }
  return min
}

function refreshCentroid(cluster) {
  const n = cluster.cards.length
  cluster.lat = cluster.cards.reduce((s, x) => s + x.geo.lat, 0) / n
  cluster.lng = cluster.cards.reduce((s, x) => s + x.geo.lng, 0) / n
}

/**
 * @param {Array<{geo:{lat:number,lng:number}}>} cards
 * @param {number} scale
 * @returns {Array<{lat:number,lng:number,cards:Array}>}
 */
function clusterCards(cards, scale) {
  const list = (cards || []).filter(
    (c) => c && c.geo && typeof c.geo.lat === 'number' && typeof c.geo.lng === 'number'
  )
  if (!list.length) return []

  const avgLat = list.reduce((s, c) => s + c.geo.lat, 0) / list.length
  const threshold = Math.max(1e-7, thresholdForScale(scale, avgLat))

  let clusters = list.map((card) => ({
    lat: Number(card.geo.lat),
    lng: Number(card.geo.lng),
    cards: [card]
  }))

  let merged = true
  let guard = 0
  while (merged && guard < 128) {
    guard += 1
    merged = false
    const next = []
    const used = {}

    for (let i = 0; i < clusters.length; i++) {
      if (used[i]) continue
      const acc = {
        lat: clusters[i].lat,
        lng: clusters[i].lng,
        cards: clusters[i].cards.slice()
      }
      used[i] = true

      // 每一轮把所有与当前簇「任一点够近」的簇吸进来
      let grew = true
      while (grew) {
        grew = false
        for (let j = 0; j < clusters.length; j++) {
          if (used[j]) continue
          if (minDistBetweenClusters(acc, clusters[j]) <= threshold) {
            used[j] = true
            acc.cards = acc.cards.concat(clusters[j].cards)
            refreshCentroid(acc)
            grew = true
            merged = true
          }
        }
      }
      next.push(acc)
    }
    clusters = next
  }

  return clusters
}

module.exports = {
  thresholdForScale,
  clusterCards
}
