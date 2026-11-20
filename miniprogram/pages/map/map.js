const api = require('../../services/api')
const copy = require('../../constants/copy')
const { formatDateTime, cardDisplayName, formatDateShort } = require('../../utils/format')
const { pickCardImage } = require('../../utils/card-media')
const { normalizeGeo } = require('../../utils/geo-blur')
const nav = require('../../utils/navigate')
const pageLoad = require('../../utils/page-load')

const DEFAULT_CENTER = { latitude: 31.2304, longitude: 121.4737 }
const EMPTY_SCALE = 13
const CAT_ICONS = [
  '/assets/illus/map-cat-1.png',
  '/assets/illus/map-cat-2.png',
  '/assets/illus/map-cat-3.png'
]
/** 聚合簇用同一只猫标 + 数量角标 */
const CLUSTER_ICON = CAT_ICONS[0]

function createDefaultSetting() {
  return {
    showLocation: true,
    enableSatellite: false,
    enableTraffic: false,
    enablePoi: false,
    enableBuilding: false,
    showCompass: false,
    showScale: false,
    showMarkers: true,
    showWash: true,
    showVeil: true,
    enableScroll: true,
    enableZoom: true,
    enableRotate: false,
    enable3D: false,
    enableOverlooking: false,
    scale: EMPTY_SCALE,
    rotate: 0,
    skew: 0
  }
}

const SETTING_GROUPS = [
  {
    id: 'look',
    title: '图层与外观',
    options: [
      { type: 'toggle', key: 'showLocation', name: '显示定位点', desc: '蓝点显示当前位置' },
      { type: 'toggle', key: 'enableSatellite', name: '卫星图', desc: '切换卫星影像底图' },
      { type: 'toggle', key: 'enableTraffic', name: '实时路况', desc: '叠加道路拥堵颜色' },
      { type: 'toggle', key: 'enablePoi', name: '显示 POI', desc: '商店、地标等兴趣点' },
      { type: 'toggle', key: 'enableBuilding', name: '显示建筑物', desc: '楼块轮廓/立体感' },
      { type: 'toggle', key: 'showCompass', name: '指南针', desc: '旋转后显示指北针' },
      { type: 'toggle', key: 'showScale', name: '比例尺', desc: '左下角距离比例（部分环境不显示）' },
      { type: 'toggle', key: 'showMarkers', name: '小猫标记', desc: '是否显示足迹猫标' },
      { type: 'toggle', key: 'showWash', name: '浅雾压马路', desc: '压低路网对比，让地图更干净' },
      { type: 'toggle', key: 'showVeil', name: '边缘氛围', desc: '顶部/底部浅色渐变' }
    ]
  },
  {
    id: 'interact',
    title: '交互',
    options: [
      { type: 'toggle', key: 'enableScroll', name: '允许拖动', desc: '手指拖动平移地图' },
      { type: 'toggle', key: 'enableZoom', name: '允许缩放', desc: '双指捏合缩放' },
      { type: 'toggle', key: 'enableRotate', name: '允许旋转', desc: '双指旋转地图朝向' },
      { type: 'toggle', key: 'enable3D', name: '3D 楼块', desc: '开启三维建筑（需配合俯视）' },
      { type: 'toggle', key: 'enableOverlooking', name: '允许俯视', desc: '双指调节俯仰角' }
    ]
  },
  {
    id: 'camera',
    title: '视角数值',
    options: [
      { type: 'range', key: 'scale', name: '缩放级别', desc: '3 最远 · 20 最近', min: 3, max: 20, step: 1 },
      { type: 'range', key: 'rotate', name: '旋转角度', desc: '0~360，相对正北', min: 0, max: 360, step: 5 },
      { type: 'range', key: 'skew', name: '俯仰角', desc: '0 平视 · 40 最大俯视', min: 0, max: 40, step: 1 }
    ]
  }
]

Page({
  data: {
    latitude: DEFAULT_CENTER.latitude,
    longitude: DEFAULT_CENTER.longitude,
    /** 原生聚合用 addMarkers，组件 markers 保持空 */
    markers: [],
    mapSetting: createDefaultSetting(),
    settingGroups: SETTING_GROUPS,
    showSettings: false,
    bubble: null,
    /** 聚合点内可左右切换的多只猫 */
    bubbleGroup: null,
    detailCard: null,
    clusterSheet: null,
    emptyMain: copy.empty.mapMain,
    emptySub: copy.empty.mapSub,
    goShoot: copy.buttons.goShoot,
    footprintCount: 0,
    albumCount: 0,
    pageLoading: false,
    loadingText: copy.tips.pageLoading,
    ready: false,
    statusBar: 20,
    navHeight: 32,
    navBarHeight: 64,
    chipTop: 72
  },

  _geoCards: [],
  _markerIdToCard: {},
  _ignoreMapTapUntil: 0,
  _centerAnimTimer: null,
  _regionTimer: null,
  _mapCtx: null,
  _clusterReady: false,
  _clusterListening: false,
  _pendingMarkerSync: false,

  onLoad() {
    try {
      const win = (wx.getWindowInfo && wx.getWindowInfo()) || {}
      const menu = wx.getMenuButtonBoundingClientRect()
      const statusBar = win.statusBarHeight || 20
      const navHeight = menu.height || 32
      const navBarHeight = (menu.bottom || statusBar + navHeight) + 8
      const chipTop = navBarHeight + 8
      this.setData({ statusBar, navHeight, navBarHeight, chipTop })
    } catch (e) {
      /* keep defaults */
    }
  },

  onReady() {
    this._mapCtx = wx.createMapContext('footprintMap', this)
    this._setupNativeCluster()
  },

  onUnload() {
    this.__mxhUnloaded = true
    this._stopCenterAnim()
    if (this._regionTimer) clearTimeout(this._regionTimer)
  },

  _setupNativeCluster() {
    const ctx = this._mapCtx
    if (!ctx || typeof ctx.initMarkerCluster !== 'function') {
      console.warn('[map] native cluster unsupported, markers may overlap')
      this._clusterReady = false
      this._syncNativeMarkers()
      return
    }

    if (!this._clusterListening && typeof ctx.on === 'function') {
      this._clusterListening = true
      ctx.on('markerClusterCreate', (res) => this._onNativeClusterCreate(res))
      ctx.on('markerClusterClick', (res) => this._onNativeClusterClick(res))
    }

    ctx.initMarkerCluster({
      enableDefaultStyle: false,
      zoomOnClick: false,
      gridSize: 72,
      complete: () => {
        this._clusterReady = true
        this._syncNativeMarkers()
      },
      fail: (err) => {
        console.warn('[map] initMarkerCluster fail', err)
        this._clusterReady = false
        this._syncNativeMarkers()
      }
    })
  },

  _onNativeClusterCreate(res) {
    if (this.__mxhUnloaded || !this._mapCtx) return
    const clusters = (res && res.clusters) || []
    if (!clusters.length) return

    const markers = clusters.map((cluster) => {
      const center = cluster.center || {}
      const count = (cluster.markerIds && cluster.markerIds.length) || 0
      return {
        latitude: Number(center.latitude),
        longitude: Number(center.longitude),
        width: 56,
        height: 56,
        iconPath: CLUSTER_ICON,
        clusterId: cluster.clusterId,
        anchor: { x: 0.5, y: 0.5 },
        zIndex: 20 + count,
        label: {
          content: String(count),
          color: '#102418',
          fontSize: 14,
          borderRadius: 16,
          bgColor: '#5aef9a',
          padding: 6,
          textAlign: 'center',
          anchorX: 18,
          anchorY: -24
        }
      }
    })

    this._mapCtx.addMarkers({
      markers,
      clear: false
    })
  },

  _onNativeClusterClick(res) {
    this._ignoreMapTapUntil = Date.now() + 400
    const cluster = (res && res.cluster) || res || {}
    const markerIds = cluster.markerIds || []
    const cards = markerIds
      .map((id) => this._markerIdToCard[id])
      .filter(Boolean)
    if (!cards.length) return
    const lat = cluster.center && cluster.center.latitude
    const lng = cluster.center && cluster.center.longitude
    if (Number.isFinite(Number(lat)) && Number.isFinite(Number(lng))) {
      this._lerpToCenter(lat, lng, 360)
    }
    this._openClusterBubble({ cards }, 0)
  },

  _syncNativeMarkers() {
    if (this.__mxhUnloaded) return
    if (!this._mapCtx) {
      this._pendingMarkerSync = true
      return
    }
    // 等原生聚合初始化完成再挂点（否则 joinCluster 可能不生效）
    if (!this._clusterReady && typeof this._mapCtx.initMarkerCluster === 'function') {
      this._pendingMarkerSync = true
      return
    }
    this._pendingMarkerSync = false

    const show = this.data.mapSetting && this.data.mapSetting.showMarkers !== false
    const cards = this._geoCards || []
    this._markerIdToCard = {}

    if (!show || !cards.length) {
      this._mapCtx.addMarkers({
        markers: [],
        clear: true
      })
      return
    }

    const joinCluster = !!this._clusterReady
    const markers = cards.map((card, index) => {
      const id = index + 1
      this._markerIdToCard[id] = card
      return {
        id,
        latitude: card.geo.lat,
        longitude: card.geo.lng,
        iconPath: CAT_ICONS[index % CAT_ICONS.length],
        width: 56,
        height: 56,
        anchor: { x: 0.5, y: 0.5 },
        joinCluster,
        zIndex: 10
      }
    })

    this._mapCtx.addMarkers({
      markers,
      clear: true,
      complete: () => {
        if (this._pendingMarkerSync) this._syncNativeMarkers()
      },
      fail: (err) => console.warn('[map] addMarkers fail', err)
    })
  },

  _stopCenterAnim() {
    if (this._centerAnimTimer) {
      clearTimeout(this._centerAnimTimer)
      this._centerAnimTimer = null
    }
  },

  _ease(t) {
    return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2
  },

  _lerpToCenter(lat, lng, duration = 420) {
    const toLat = Number(lat)
    const toLng = Number(lng)
    if (!Number.isFinite(toLat) || !Number.isFinite(toLng)) return

    this._stopCenterAnim()

    const fromLat = Number(this.data.latitude)
    const fromLng = Number(this.data.longitude)
    if (!Number.isFinite(fromLat) || !Number.isFinite(fromLng)) {
      this.setData({ latitude: toLat, longitude: toLng })
      return
    }

    const dist = Math.abs(toLat - fromLat) + Math.abs(toLng - fromLng)
    if (dist < 0.00001) {
      this.setData({ latitude: toLat, longitude: toLng })
      return
    }

    const start = Date.now()
    const step = () => {
      if (this.__mxhUnloaded) return
      const t = Math.min(1, (Date.now() - start) / duration)
      const k = this._ease(t)
      this.setData({
        latitude: fromLat + (toLat - fromLat) * k,
        longitude: fromLng + (toLng - fromLng) * k
      })
      if (t < 1) {
        this._centerAnimTimer = setTimeout(step, 16)
      } else {
        this._centerAnimTimer = null
        this.setData({ latitude: toLat, longitude: toLng })
      }
    }
    step()
  },

  onShow() {
    this.load()
  },

  noop() {},

  load() {
    return pageLoad.run(this, () => this._loadInner())
  },

  async _loadInner() {
    // 一进地图：先把当前位置放到中心
    const loc = await this.getUserLocation()
    if (loc) {
      this.setData({
        latitude: loc.latitude,
        longitude: loc.longitude,
        'mapSetting.showLocation': true,
        'mapSetting.scale': EMPTY_SCALE
      })
    }

    let fill = null
    try {
      fill = await api.backfillMissingCardGeo()
      if (fill && fill.updated > 0) {
        wx.showToast({
          title: `已整理 ${fill.withGeoCount || fill.updated} 只猫的足迹`,
          icon: 'none'
        })
      } else if (fill && fill.needAuth) {
        wx.showToast({ title: '开启定位后可为旧猫补足迹', icon: 'none' })
      }
    } catch (e) {
      console.warn('[map] backfill geo', e)
    }

    let cards = (fill && fill.cards) || []
    if (!cards.length) {
      const listed = await api.listCards({})
      cards = listed.cards || []
    }
    const withGeo = (cards || [])
      .map((c) => {
        const geo = normalizeGeo(c && c.geo)
        return geo ? { ...c, geo } : null
      })
      .filter(Boolean)
    this._geoCards = withGeo

    const patch = {
      bubble: null,
      bubbleGroup: null,
      detailCard: null,
      clusterSheet: null,
      ready: true,
      footprintCount: withGeo.length,
      albumCount: (cards || []).length
    }

    if (!loc) {
      if (withGeo.length) {
        patch.latitude = withGeo.reduce((s, c) => s + c.geo.lat, 0) / withGeo.length
        patch.longitude = withGeo.reduce((s, c) => s + c.geo.lng, 0) / withGeo.length
        patch['mapSetting.scale'] = withGeo.length === 1 ? 14 : 12
      } else {
        patch.latitude = DEFAULT_CENTER.latitude
        patch.longitude = DEFAULT_CENTER.longitude
      }
    }

    this.setData(patch, () => {
      if (this._clusterReady || !this._mapCtx) {
        this._syncNativeMarkers()
      } else {
        this._pendingMarkerSync = true
      }
    })
  },

  onRegionChange(e) {
    // 拖拽结束不要回写 scale：会触发地图重新套缩放，看起来像「拖完自动缩放」
    const type = (e && e.type) || (e.detail && e.detail.type) || ''
    if (type && type !== 'end') return
    const causedBy = (e && e.causedBy) || (e.detail && e.detail.causedBy) || ''
    // 仅双指缩放时回写；drag / update 等一律忽略
    if (causedBy !== 'scale') return

    const detailScale = Number(e && e.detail && e.detail.scale)
    if (!Number.isFinite(detailScale)) return
    if (Math.abs((this.data.mapSetting.scale || 0) - detailScale) > 0.05) {
      this.setData({ 'mapSetting.scale': detailScale })
    }
  },


  getUserLocation() {
    return new Promise((resolve) => {
      wx.getLocation({
        type: 'gcj02',
        success: (res) => {
          resolve({
            latitude: res.latitude,
            longitude: res.longitude
          })
        },
        fail: () => resolve(null)
      })
    })
  },

  onBack() {
    wx.navigateBack({ fail: () => nav.switchTab(this, '/pages/album/album') })
  },

  onOpenSettings() {
    this.setData({
      showSettings: true,
      bubble: null,
      bubbleGroup: null,
      detailCard: null,
      clusterSheet: null
    })
  },

  onCloseSettings() {
    this.setData({ showSettings: false })
  },

  onResetSettings() {
    this.setData({ mapSetting: createDefaultSetting() }, () => {
      this._syncNativeMarkers()
    })
  },

  onToggleSetting(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    this.setData({ [`mapSetting.${key}`]: !this.data.mapSetting[key] }, () => {
      if (key === 'showMarkers') this._syncNativeMarkers()
    })
  },

  onSlideSetting(e) {
    const key = e.currentTarget.dataset.key
    if (!key) return
    const value = Number(e.detail.value)
    this.setData({ [`mapSetting.${key}`]: value })
  },

  onNudgeSetting(e) {
    const { key, dir, step } = e.currentTarget.dataset
    if (!key) return
    const option = SETTING_GROUPS.flatMap((g) => g.options).find((o) => o.key === key)
    if (!option || option.type !== 'range') return
    const cur = Number(this.data.mapSetting[key]) || 0
    const delta = (Number(dir) || 0) * (Number(step) || option.step || 1)
    const next = Math.min(option.max, Math.max(option.min, cur + delta))
    this.setData({ [`mapSetting.${key}`]: next })
  },

  async onRecenter() {
    const loc = await this.getUserLocation()
    if (!loc) {
      wx.showToast({ title: '定位失败，请检查权限', icon: 'none' })
      return
    }
    this.setData({
      'mapSetting.scale': EMPTY_SCALE,
      'mapSetting.showLocation': true
    })
    // 只用经纬度居中：moveToLocation 在开发者工具会直接报错
    this._lerpToCenter(loc.latitude, loc.longitude, 480)
  },

  _markerIdFromEvent(e) {
    if (!e) return null
    let id = null
    if (e.detail && e.detail.markerId != null) id = e.detail.markerId
    else if (e.markerId != null) id = e.markerId
    if (id == null) return null
    const n = Number(id)
    return Number.isFinite(n) ? n : id
  },

  _bubbleFromCard(card) {
    if (!card) return null
    const pending = card.breedReviewStatus === 'pending' || !!card.pendingBreed
    const conf = Number(card.confidence) || 0
    const geo = card.geo || {}
    const geoLabel =
      typeof geo.lat === 'number' && typeof geo.lng === 'number'
        ? `${geo.lat.toFixed(5)}, ${geo.lng.toFixed(5)}`
        : ''
    // 邮戳展示用：dateShort 形如 2026.11.20 → 年 2026 / 月日 11.20
    const dateShortText = formatDateShort(card.shotAt) || ''
    return {
      stampYear: dateShortText ? dateShortText.slice(0, 4) : '',
      stampMd: dateShortText ? dateShortText.slice(5) : '',
      id: card._id,
      image: pickCardImage(card),
      name: cardDisplayName(card),
      breed: card.breed || '待识别',
      recognizedBreed: card.recognizedBreed || '',
      confidence: conf > 0 ? conf : 0,
      date: formatDateTime(card.shotAt) || '时间未记录',
      dateShort: formatDateShort(card.shotAt) || '',
      place: (card.placeText || '').trim() === '已记录当前位置' ? '' : (card.placeText || '').trim(),
      geoLabel,
      note: (card.note || '').trim(),
      memoryCount: Number(card.memoryCount) || 0,
      pending,
      pendingBreed: card.pendingBreed || '',
      mattingFailed: !!card.mattingFailed,
      canOpenArchive: !!(card._id && String(card._id).indexOf('debug_') !== 0)
    }
  },

  _openClusterBubble(cluster, startIndex = 0) {
    const items = (cluster.cards || [])
      .slice()
      .sort((a, b) => (b.shotAt || 0) - (a.shotAt || 0))
      .map((c) => this._bubbleFromCard(c))
      .filter(Boolean)
    if (!items.length) return

    if (items.length === 1) {
      const only = items[0]
      if (
        this.data.bubble &&
        this.data.bubble.id === only.id &&
        !this.data.detailCard &&
        !(this.data.bubbleGroup && this.data.bubbleGroup.count > 1)
      ) {
        this.setData({ bubble: null, bubbleGroup: null, clusterSheet: null })
        return
      }
      this.setData({
        bubble: only,
        bubbleGroup: null,
        clusterSheet: null,
        detailCard: null
      })
      return
    }

    const index = Math.max(0, Math.min(items.length - 1, Number(startIndex) || 0))
    this.setData({
      bubble: items[index],
      bubbleGroup: {
        items,
        index,
        count: items.length
      },
      clusterSheet: null,
      detailCard: null
    })
  },

  onOpenClusterList() {
    const group = this.data.bubbleGroup
    if (!group || !group.items || group.count <= 1) return
    this.setData({
      clusterSheet: {
        count: group.count,
        title: `这里有 ${group.count} 只猫`,
        items: group.items
      }
    })
  },

  onMarkerTap(e) {
    this._ignoreMapTapUntil = Date.now() + 400

    const markerId = this._markerIdFromEvent(e)
    const card = this._markerIdToCard[markerId]
    if (!card) {
      // 聚合簇点击走 markerClusterClick；这里忽略
      return
    }

    this._lerpToCenter(card.geo.lat, card.geo.lng, 360)
    this._openClusterBubble({ cards: [card] }, 0)
  },

  onCalloutTap(e) {
    this.onMarkerTap(e)
  },

  onBubbleSwiperChange(e) {
    const group = this.data.bubbleGroup
    if (!group || !group.items || !group.items.length) return
    const index = Number(e && e.detail && e.detail.current)
    if (!Number.isFinite(index) || index < 0 || index >= group.items.length) return
    this.setData({
      bubble: group.items[index],
      'bubbleGroup.index': index
    })
  },

  onBubbleCardTap(e) {
    const id = e.currentTarget.dataset.id
    const group = this.data.bubbleGroup
    const hit =
      (group && group.items && group.items.find((x) => x.id === id)) || this.data.bubble
    if (!hit) return
    this.setData({ detailCard: hit, bubble: hit })
  },

  onMapTap() {
    if (Date.now() < (this._ignoreMapTapUntil || 0)) return
    if (this.data.detailCard) return
    const patch = {}
    if (this.data.bubble) patch.bubble = null
    if (this.data.bubbleGroup) patch.bubbleGroup = null
    if (this.data.clusterSheet) patch.clusterSheet = null
    if (Object.keys(patch).length) this.setData(patch)
  },

  onCloseClusterSheet() {
    this.setData({ clusterSheet: null })
  },

  onPickClusterItem(e) {
    const id = e.currentTarget.dataset.id
    const sheet = this.data.clusterSheet
    const group = this.data.bubbleGroup
    const items = (group && group.items) || (sheet && sheet.items) || []
    const index = items.findIndex((x) => x.id === id)
    if (index < 0) return
    const item = items[index]
    this.setData({
      clusterSheet: null,
      bubble: item,
      bubbleGroup:
        items.length > 1
          ? {
              items,
              index,
              count: items.length
            }
          : null,
      detailCard: item
    })
  },

  onBubble() {
    const bubble = this.data.bubble
    if (!bubble) return
    this.setData({ detailCard: bubble })
  },

  // 兼容旧调用名
  onBubblePrev() {
    const group = this.data.bubbleGroup
    if (!group || group.count <= 1) return
    const index = (group.index - 1 + group.count) % group.count
    this.setData({ bubble: group.items[index], 'bubbleGroup.index': index })
  },

  onBubbleNext() {
    const group = this.data.bubbleGroup
    if (!group || group.count <= 1) return
    const index = (group.index + 1) % group.count
    this.setData({ bubble: group.items[index], 'bubbleGroup.index': index })
  },

  onCloseDetail() {
    this.setData({ detailCard: null })
  },

  onOpenArchive() {
    const id = this.data.detailCard && this.data.detailCard.id
    if (!id || String(id).indexOf('debug_') === 0) {
      wx.showToast({ title: '调试卡无档案', icon: 'none' })
      return
    }
    this.setData({ detailCard: null, bubble: null, bubbleGroup: null, clusterSheet: null })
    nav.navigateTo(this, `/pages/card-detail/card-detail?id=${id}`)
  },

  onGoShoot() {
    nav.navigateTo(this, '/pages/camera/camera')
  }
})
