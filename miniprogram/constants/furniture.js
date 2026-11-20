/**
 * 轻量装修：可摆家具（CSS 像素风）
 * x/y 为场景百分比；z 越大越靠前
 * defaultPlaced：无存档时默认是否摆出（少摆，把中心留给猫）
 */
const FURNITURE_CATALOG = [
  {
    id: 'window',
    name: '窗台',
    kind: 'window',
    defaultX: 22,
    defaultY: 18,
    w: 30,
    h: 24,
    z: 1,
    movable: true,
    defaultPlaced: true
  },
  {
    id: 'plant',
    name: '绿植',
    kind: 'plant',
    defaultX: 84,
    defaultY: 42,
    w: 14,
    h: 24,
    z: 2,
    movable: true,
    defaultPlaced: true
  },
  {
    id: 'cushion',
    name: '猫窝',
    kind: 'cushion',
    defaultX: 72,
    defaultY: 66,
    w: 28,
    h: 16,
    z: 3,
    movable: true,
    defaultPlaced: true
  },
  {
    id: 'bowl',
    name: '食盆',
    kind: 'bowl',
    defaultX: 20,
    defaultY: 68,
    w: 12,
    h: 10,
    z: 4,
    movable: true,
    defaultPlaced: true
  },
  {
    id: 'toy',
    name: '逗猫棒',
    kind: 'toy',
    defaultX: 40,
    defaultY: 62,
    w: 12,
    h: 18,
    z: 5,
    movable: true,
    defaultPlaced: true
  }
]

function defaultLayout() {
  return FURNITURE_CATALOG.map((f) => ({
    id: f.id,
    x: f.defaultX,
    y: f.defaultY,
    placed: f.defaultPlaced !== false
  }))
}

function mergeLayout(saved) {
  const map = {}
  ;(saved || []).forEach((item) => {
    if (item && item.id) map[item.id] = item
  })
  return FURNITURE_CATALOG.map((f) => {
    const s = map[f.id]
    return {
      id: f.id,
      name: f.name,
      kind: f.kind,
      w: f.w,
      h: f.h,
      z: f.z,
      movable: f.movable,
      x: s && typeof s.x === 'number' ? s.x : f.defaultX,
      y: s && typeof s.y === 'number' ? s.y : f.defaultY,
      placed: s ? s.placed !== false : f.defaultPlaced !== false
    }
  })
}

function serializeLayout(items) {
  return (items || []).map((f) => ({
    id: f.id,
    x: Math.round(Number(f.x) * 10) / 10,
    y: Math.round(Number(f.y) * 10) / 10,
    placed: f.placed !== false
  }))
}

module.exports = {
  FURNITURE_CATALOG,
  defaultLayout,
  mergeLayout,
  serializeLayout
}
