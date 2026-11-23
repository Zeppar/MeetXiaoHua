const api = require('../../services/api')
const cache = require('../../services/storage-cache')
const copy = require('../../constants/copy')
const { formatDateTime, cardDisplayName, formatDateShort } = require('../../utils/format')
const { pickCardImage } = require('../../utils/card-media')
const { getCurrentPosition, normalizeGeo, spreadFootprints } = require('../../utils/geo-blur')
const nav = require('../../utils/navigate')
const pageLoad = require('../../utils/page-load')

/** 定位失败时使用青岛市南区百盛商业大厦作为地图中心。 */
const DEFAULT_CENTER = { latitude: 36.0669, longitude: 120.3185 }
const EMPTY_SCALE = 13
const MIN_MAP_SCALE = 3
const MAX_MAP_SCALE = 20
const ZOOM_KEYS = ['scale', 'minScale', 'maxScale']
const TILT_START_SCALE = 16
const TILT_END_SCALE = 19
const PINCH_TILT_FRAME_MS = 40
const PINCH_SETTLE_MS = 160
const SCALE_SAMPLE_MS = 110
const SCALE_SAMPLE_TAIL_MS = 380
const SCALE_SAMPLE_LIMIT_MS = 8000
const CAMERA_READ_TIMEOUT_MS = 500

function tiltAtScale(scale, maxTilt) {
  const progress = Math.max(0, Math.min(1, (scale - TILT_START_SCALE) / (TILT_END_SCALE - TILT_START_SCALE)))
  // 进出倾角区间时缓一点，避免接近端点时突然抬头。
  return Math.round(maxTilt * progress * progress * (3 - 2 * progress))
}

function pinchSpan(touches) {
  if (!touches || touches.length !== 2) return 0
  const [a, b] = touches
  const dx = (a.clientX ?? a.pageX) - (b.clientX ?? b.pageX)
  const dy = (a.clientY ?? a.pageY) - (b.clientY ?? b.pageY)
  return Math.hypot(dx, dy) || 0
}

function clampZoom(scale, setting) {
  return Math.max(setting.minScale, Math.min(setting.maxScale, scale))
}

function nativeMapSetting(setting, scale) {
  const { showMarkers, showWash, showVeil, enableZoom, minScale, maxScale, scale: initialScale, ...native } = setting
  const skew = tiltAtScale(scale, setting.skew)
  return { ...native, skew, enable3D: setting.enable3D && skew > 0, enableOverlooking: setting.skew > 0 }
}

const CAT_ICONS = [
  '/assets/illus/map-cat-1.png',
  '/assets/illus/map-cat-2.png',
  '/assets/illus/map-cat-3.png'
]
/** 聚合簇用同一只猫标 + 数量角标 */
const CLUSTER_ICON = CAT_ICONS[0]

function createBaseSetting() {
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
    enable3D: true,
    scale: EMPTY_SCALE,
    minScale: MIN_MAP_SCALE,
    maxScale: MAX_MAP_SCALE,
    rotate: 0,
    skew: 32
  }
}

function sanitizeSetting(raw) {
  const base = createBaseSetting()
  if (!raw || typeof raw !== 'object') return base
  const next = { ...base }
  Object.keys(base).forEach((key) => {
    if (raw[key] === undefined) return
    if (typeof base[key] === 'boolean') next[key] = !!raw[key]
    else if (typeof base[key] === 'number') {
      const n = Number(raw[key])
      const isZoom = ZOOM_KEYS.includes(key)
      const [min, max] = isZoom ? [MIN_MAP_SCALE, MAX_MAP_SCALE] : key === 'rotate' ? [0, 360] : [0, 40]
      const value = raw[key] != null && raw[key] !== '' && Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : base[key]
      next[key] = isZoom ? Math.round(value) : value
    } else next[key] = raw[key]
  })
  next.minScale = Math.min(next.minScale, MAX_MAP_SCALE - 1)
  next.maxScale = Math.max(next.maxScale, next.minScale + 1)
  next.scale = clampZoom(next.scale, next)
  return next
}

function loadMapSetting() {
  const saved = cache.getMapPrefs() || {}
  if (saved.autoView) return sanitizeSetting(saved.autoView)
  const modes = saved.modes || {}
  const flat = modes["2d"] || {}
  const tilted = modes["3d"] || {}
  // 保留原来进入地图的设置和近景最大倾角。
  return sanitizeSetting({ ...flat, skew: tilted.skew, enable3D: tilted.enable3D, enableBuilding: tilted.enableBuilding ?? flat.enableBuilding })
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
      { type: 'toggle', key: 'enable3D', name: '3D 楼块', desc: '地图倾斜后显示立体楼块' }
    ]
  },
  {
    id: 'camera',
    title: '视角数值',
    options: [
      { type: 'range', key: 'minScale', name: '最小缩放级别', desc: '拉远地图时的下限', min: MIN_MAP_SCALE, max: MAX_MAP_SCALE - 1, step: 1 },
      { type: 'range', key: 'maxScale', name: '最大缩放级别', desc: '放大地图时的上限', min: MIN_MAP_SCALE + 1, max: MAX_MAP_SCALE, step: 1 },
      { type: 'range', key: 'scale', name: '初始缩放', desc: '进入地图时的缩放级别', min: MIN_MAP_SCALE, max: MAX_MAP_SCALE, step: 1 },
      { type: 'range', key: 'rotate', name: '旋转角度', desc: '0~360，相对正北', min: 0, max: 360, step: 5 },
      { type: 'range', key: 'skew', name: '最大倾角', desc: '放大到 19 级时达到此角度，0 始终垂直俯视', min: 0, max: 40, step: 1 }
    ]
  }
]

function settingGroupsFor(setting) {
  const zoomBounds = {
    minScale: { max: setting.maxScale - 1 },
    maxScale: { min: setting.minScale + 1 },
    scale: { min: setting.minScale, max: setting.maxScale }
  }
  return SETTING_GROUPS.map((group) => {
    if (group.id !== 'camera') return group
    const options = group.options.map((option) => {
      const bounds = zoomBounds[option.key]
      if (!bounds) return option
      const range = { ...option, ...bounds }
      // 原生 slider 需要不同的端点。只有一个合法值时保留基础范围并禁用。
      if (range.min === range.max) return { ...option, disabled: true }
      return range
    })
    return { ...group, options }
  })
}

Page({
  data: {
    latitude: DEFAULT_CENTER.latitude,
    longitude: DEFAULT_CENTER.longitude,
    /** 原生聚合用 addMarkers，组件 markers 保持空 */
    markers: [],
    mapSetting: createBaseSetting(),
    mapScale: EMPTY_SCALE,
    nativeMapSetting: nativeMapSetting(createBaseSetting(), EMPTY_SCALE),
    cameraZoomText: '—',
    cameraTiltText: '—',
    mapMounted: false,
    settingGroups: settingGroupsFor(createBaseSetting()),
    showSettings: false,
    settingsDirty: false,
    sliderSeed: 1,
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
    simulatingFootprints: false,
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
  _mapCtx: null,
  _clusterReady: false,
  _clusterInitializing: false,
  _clusterListening: false,
  _clusterMarkerIds: [],
  _clusterMarkerSequence: 0,
  _clusterRenderSequence: 0,
  _pendingMarkerSync: false,
  _viewScale: EMPTY_SCALE,
  _scaleReadSequence: 0,
  _scaleSampleTimer: null,
  _scaleSampleUntil: 0,
  _samplingSkew: false,
  _pinch: null,
  _pinchTiltTimer: null,
  _pinchSettleTimer: null,
  _appliedTilt: 0,

  onLoad() {
    const enterSetting = loadMapSetting()
    this._viewScale = enterSetting.scale
    const nativeSetting = nativeMapSetting(enterSetting, this._viewScale)
    this._appliedTilt = nativeSetting.skew
    try {
      const win = (wx.getWindowInfo && wx.getWindowInfo()) || {}
      const menu = wx.getMenuButtonBoundingClientRect()
      const statusBar = win.statusBarHeight || 20
      const navHeight = menu.height || 32
      const navBarHeight = (menu.bottom || statusBar + navHeight) + 8
      const chipTop = navBarHeight + 8
      this.setData({
        statusBar,
        navHeight,
        navBarHeight,
        chipTop,
        mapMounted: true,
        mapSetting: enterSetting,
        settingGroups: settingGroupsFor(enterSetting),
        mapScale: enterSetting.scale,
        nativeMapSetting: nativeSetting,
        settingsDirty: false
      })
    } catch (e) {
      this.setData({
        mapMounted: true,
        mapSetting: enterSetting,
        settingGroups: settingGroupsFor(enterSetting),
        mapScale: enterSetting.scale,
        nativeMapSetting: nativeSetting,
        settingsDirty: false
      })
    }
  },

  onReady() {
    this._mapCtx = wx.createMapContext('footprintMap', this)
    this._setupNativeCluster()
    this._refreshZoomTilt()
  },

  onUnload() {
    this.__mxhUnloaded = true
    this._clearPinchTracking()
    this._stopScaleSampling()
    this._stopCenterAnim()
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
      ctx.on('markerClusterCreate', (res) => {
        if (this._mapCtx === ctx) this._onNativeClusterCreate(res)
      })
      ctx.on('markerClusterClick', (res) => {
        if (!this.__mxhUnloaded && this._mapCtx === ctx) this._onNativeClusterClick(res)
      })
    }

    this._clusterInitializing = true
    ctx.initMarkerCluster({
      enableDefaultStyle: false,
      zoomOnClick: false,
      gridSize: 72,
      success: () => {
        if (this._mapCtx === ctx) this._clusterReady = true
      },
      fail: (err) => console.warn('[map] initMarkerCluster fail', err),
      complete: () => {
        if (this._mapCtx !== ctx) return
        this._clusterInitializing = false
        this._syncNativeMarkers()
      }
    })
  },

  _onNativeClusterCreate(res) {
    if (this.__mxhUnloaded || !this._mapCtx) return
    const clusters = (res && res.clusters) || []
    const ctx = this._mapCtx
    if (!this.data.mapSetting.showMarkers || !clusters.length) {
      const previousMarkerIds = this._clusterMarkerIds.slice()
      this._clusterMarkerIds = []
      this._clusterRenderSequence++
      if (previousMarkerIds.length && typeof ctx.removeMarkers === 'function') {
        ctx.removeMarkers({ markerIds: previousMarkerIds })
      }
      return
    }

    const renderSequence = ++this._clusterRenderSequence
    const previousMarkerIds = this._clusterMarkerIds.slice()
    const markers = clusters.map((cluster) => {
      const center = cluster.center || {}
      const count = (cluster.markerIds && cluster.markerIds.length) || 0
      const id = 100000 + (++this._clusterMarkerSequence)
      return {
        id,
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

    const addClusters = () => {
      if (this.__mxhUnloaded || this._mapCtx !== ctx || renderSequence !== this._clusterRenderSequence) return
      this._clusterMarkerIds = markers.map((marker) => marker.id)
      ctx.addMarkers({ markers, clear: false })
    }
    if (previousMarkerIds.length && typeof ctx.removeMarkers === 'function') {
      ctx.removeMarkers({
        markerIds: previousMarkerIds,
        success: addClusters,
        fail: addClusters
      })
      return
    }
    addClusters()
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
    if (this._clusterInitializing) {
      this._pendingMarkerSync = true
      return
    }
    this._pendingMarkerSync = false
    this._clusterRenderSequence++
    this._clusterMarkerIds = []

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
    // 有定位：以定位为中心；拿不到定位时用固定兜底 DEFAULT_CENTER
    const loc = await this.getUserLocation()
    if (this.__mxhUnloaded) return
    if (!this._viewportInteracted && !this.data.ready && !(cache.getMapPrefs() || {}).simulationAnchorId) {
      this.setData(loc || DEFAULT_CENTER)
    }

    let fill = null
    try {
      fill = await api.backfillMissingCardGeo({
        baseLoc: loc
          ? { latitude: loc.latitude, longitude: loc.longitude }
          : null
      })
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
    if (this.__mxhUnloaded) return
    this._footprintCards = cards || []
    this._footprintLocation = loc
    this._renderFootprints()
  },

  _renderFootprints() {
    const cards = this._footprintCards
    const withGeo = cards
      .map((c) => {
        const geo = normalizeGeo(c && c.geo)
        return geo ? { ...c, geo } : null
      })
      .filter(Boolean)
    const { simulationAnchorId } = cache.getMapPrefs() || {}
    const anchor = withGeo.find((card) => card._id === simulationAnchorId)
    if (anchor) {
      const others = cards.filter((card) => card._id !== anchor._id)
        .sort((a, b) => String(a._id).localeCompare(String(b._id)))
      this._geoCards = [anchor, ...others.map((card, index) => ({
        ...card,
        geo: spreadFootprints(anchor.geo.lat, anchor.geo.lng, index, cards.length),
        simulatedGeo: true
      }))]
    } else {
      this._geoCards = withGeo
    }

    const patch = {
      bubble: null,
      bubbleGroup: null,
      detailCard: null,
      clusterSheet: null,
      ready: true,
      footprintCount: this._geoCards.length,
      albumCount: cards.length,
      simulatingFootprints: !!anchor
    }

    const loc = this._footprintLocation
    // 首次进入：定位 > 固定兜底；模拟锚点优先
    if (!this._viewportInteracted && !this.data.ready) {
      if (anchor) {
        patch.latitude = anchor.geo.lat
        patch.longitude = anchor.geo.lng
      } else if (loc) {
        Object.assign(patch, loc)
      } else {
        Object.assign(patch, DEFAULT_CENTER)
      }
    }

    this.setData(patch, () => this._syncNativeMarkers())
  },

  onRestoreFootprints() {
    if (!this.data.simulatingFootprints) return
    const prefs = { ...cache.getMapPrefs() }
    delete prefs.simulationAnchorId
    cache.setMapPrefs(prefs)
    this.setData({ showSettings: false })
    this._renderFootprints()
  },

  onMapTouchStart(e) {
    // 新触点到达时丢弃上一轮手势留下的校准回调。
    this._clearPinchTracking()
    this._scaleReadSequence++
    const span = pinchSpan(e.touches)
    if (!span || !this.data.mapSetting.enableZoom) return
    this._startScaleSampling()
    if (!this.data.mapSetting.skew) return
    this._viewportInteracted = true
    this._pinch = { span, scale: this._viewScale, endScale: null }
  },

  onMapTouchMove(e) {
    const span = pinchSpan(e.touches)
    if (!span || !this.data.mapSetting.enableZoom) return
    this._startScaleSampling()
    if (!this.data.mapSetting.skew) return
    if (!this._pinch) this.onMapTouchStart(e)
    const pinch = this._pinch
    if (!pinch) return

    // 地图缩放每增加一级，屏幕上的同一段距离约翻倍。
    if (span === pinch.span) return
    pinch.scale = clampZoom(pinch.scale + Math.log2(span / pinch.span), this.data.mapSetting)
    pinch.span = span
    pinch.endScale = null
    if (this._pinchTiltTimer) return
    this._pinchTiltTimer = setTimeout(() => {
      this._pinchTiltTimer = null
      if (this._pinch === pinch) this._applyZoomTilt(pinch.scale, false)
    }, PINCH_TILT_FRAME_MS)
  },

  onMapTouchEnd(e) {
    if (pinchSpan(e.touches)) return
    this._stopScaleSampling()
    this._finishPinch()
  },

  onMapTouchCancel() {
    this._stopScaleSampling()
    this._finishPinch()
  },

  _finishPinch() {
    if (!this._pinch) return
    const { scale, endScale } = this._pinch
    this._clearPinchTracking()
    this._applyZoomTilt(endScale ?? scale, endScale !== null)
    // 松手后补读一次，取原生动画完成后的缩放和倾角。
    this._pinchSettleTimer = setTimeout(() => {
      this._pinchSettleTimer = null
      this._refreshZoomTilt()
    }, PINCH_SETTLE_MS)
  },

  _clearPinchTracking() {
    this._pinch = null
    clearTimeout(this._pinchTiltTimer)
    clearTimeout(this._pinchSettleTimer)
    this._pinchTiltTimer = null
    this._pinchSettleTimer = null
  },

  onRegionChange(e) {
    const detail = e.detail || {}
    const type = e.type === 'begin' || e.type === 'end' ? e.type : detail.type
    const cause = detail.causedBy || e.causedBy
    if (cause === 'scale' || cause === 'gesture' || cause === 'drag') this._viewportInteracted = true

    // 手指移动期间以触点为准，地图提交倾角产生的事件可能带旧的缩放值。
    if (this._pinch) {
      if (type === 'end' && (cause === 'scale' || cause === 'gesture' || !cause)) {
        if (Number.isFinite(detail.scale)) this._pinch.endScale = detail.scale
        this._updateCameraReadout(detail.scale, detail.skew)
      }
      return
    }
    if (type === 'begin') {
      if (cause !== 'update' && this.data.mapSetting.enableZoom) this._startScaleSampling()
      return
    }
    if (type !== 'end') return
    if (cause === 'update' && (this._pinchSettleTimer || this._scaleSampleTimer)) return
    if (cause === 'drag') {
      // 原生拖拽结束可能晚于下一次缩放开始。继续取样，忽略这条事件里的旧镜头值。
      this._startScaleSampling(SCALE_SAMPLE_TAIL_MS)
      return
    }
    if (this._scaleSampleTimer) this._scaleSampleUntil = Date.now() + SCALE_SAMPLE_TAIL_MS
    this._refreshZoomTilt(detail.scale, detail.skew)
  },

  _refreshZoomTilt(scale, skew) {
    const sequence = ++this._scaleReadSequence
    this._updateCameraReadout(scale, skew)
    this._applyZoomTilt(scale)
    if (!Number.isFinite(scale)) {
      this._readMapValue('getScale', 'scale', null).then((actualScale) => {
        if (sequence !== this._scaleReadSequence || this._pinch) return
        this._updateCameraReadout(actualScale)
        this._applyZoomTilt(actualScale)
      })
    }
    if (!Number.isFinite(skew)) {
      this._readMapValue('getSkew', 'skew', null).then((actualSkew) => {
        if (sequence === this._scaleReadSequence && !this._pinch) this._updateCameraReadout(null, actualSkew)
      })
    }
  },

  _updateCameraReadout(scale, skew) {
    if (this.__mxhUnloaded) return
    const patch = {}
    if (Number.isFinite(scale)) {
      const text = scale.toFixed(2)
      if (text !== this.data.cameraZoomText) patch.cameraZoomText = text
    }
    if (Number.isFinite(skew)) {
      const text = skew.toFixed(1) + '°'
      if (text !== this.data.cameraTiltText) patch.cameraTiltText = text
    }
    if (Object.keys(patch).length) this.setData(patch)
  },

  _startScaleSampling(duration = SCALE_SAMPLE_LIMIT_MS) {
    this._scaleSampleUntil = Math.max(this._scaleSampleUntil, Date.now() + duration)
    if (this._scaleSampleTimer) return
    // 部分客户端只在手势开始和结束时发 regionchange。
    const sample = async () => {
      const timer = this._scaleSampleTimer
      const sequence = this._scaleReadSequence
      const isCurrent = () => !this.__mxhUnloaded && sequence === this._scaleReadSequence
      if (!this._samplingSkew) {
        this._samplingSkew = true
        this._readMapValue('getSkew', 'skew', null).then((skew) => {
          this._samplingSkew = false
          if (isCurrent()) this._updateCameraReadout(null, skew)
        })
      }
      const scale = await this._readMapValue('getScale', 'scale', null)
      if (this._scaleSampleTimer !== timer || this.__mxhUnloaded) return
      if (sequence === this._scaleReadSequence) {
        this._updateCameraReadout(scale)
        if (!this._pinch) this._applyZoomTilt(scale)
      }
      this._scaleSampleTimer = Date.now() < this._scaleSampleUntil ? setTimeout(sample, SCALE_SAMPLE_MS) : null
    }
    this._scaleSampleTimer = setTimeout(sample, SCALE_SAMPLE_MS)
  },

  _stopScaleSampling() {
    clearTimeout(this._scaleSampleTimer)
    this._scaleSampleTimer = null
    this._scaleSampleUntil = 0
    this._scaleReadSequence++
  },

  _applyZoomTilt(scale, confirmed = true) {
    if (this.__mxhUnloaded || !Number.isFinite(scale)) return
    const setting = this.data.mapSetting
    scale = clampZoom(scale, setting)
    if (confirmed) this._viewScale = scale
    const skew = tiltAtScale(scale, setting.skew)
    if (skew === this._appliedTilt) return
    this._appliedTilt = skew
    // 合并到现有地图配置，避免在手势中丢失其他原生属性。
    const patch = { 'nativeMapSetting.skew': skew }
    const enable3D = setting.enable3D && skew > 0
    if (enable3D !== this.data.nativeMapSetting.enable3D) patch['nativeMapSetting.enable3D'] = enable3D
    this.setData(patch)
  },

  /** 拿不到定位返回 null；DEFAULT_CENTER 只用于地图显示，不能当成真实位置写进猫卡 */
  getUserLocation() {
    if (!this._locationRequest) {
      this._locationRequest = getCurrentPosition()
        .then((loc) => loc || null)
        .finally(() => {
          this._locationRequest = null
        })
    }
    return this._locationRequest
  },

  async _centerOnUser(loc) {
    const ctx = this._mapCtx
    if (ctx && typeof ctx.moveToLocation === 'function') {
      const moved = await this._readMapValue('moveToLocation', null, false, loc)
      if (this.__mxhUnloaded) return
      if (moved) {
        await new Promise((resolve) => this.setData(loc, resolve))
        return
      }
    }
    const current = await this._readMapValue('getCenterLocation', null, null)
    if (this.__mxhUnloaded) return
    if (current && Number.isFinite(current.latitude) && Number.isFinite(current.longitude) &&
        loc.latitude === this.data.latitude && loc.longitude === this.data.longitude &&
        (Math.abs(current.latitude - loc.latitude) > 0.00001 || Math.abs(current.longitude - loc.longitude) > 0.00001)) {
      // 拖动会改变原生中心，经纬度绑定可能仍等于上次定位。
      await new Promise((resolve) => this.setData({
        latitude: current.latitude,
        longitude: current.longitude
      }, resolve))
    }
    if (!this.__mxhUnloaded) {
      await new Promise((resolve) => this.setData({
        latitude: loc.latitude,
        longitude: loc.longitude
      }, resolve))
    }
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

  _readMapValue(method, key, fallback, options) {
    const ctx = this._mapCtx
    if (!ctx || typeof ctx[method] !== 'function') return Promise.resolve(fallback)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(fallback), CAMERA_READ_TIMEOUT_MS)
      const finish = (value) => {
        clearTimeout(timer)
        resolve(value)
      }
      try {
        ctx[method]({
          ...options,
          success: (result) => finish(key ? (result && Number.isFinite(result[key]) ? result[key] : fallback) : result || true),
          fail: () => finish(fallback)
        })
      } catch (e) {
        finish(fallback)
      }
    })
  },

  onSaveSettings() {
    const saved = cache.getMapPrefs() || {}
    cache.setMapPrefs({ ...saved, autoView: sanitizeSetting(this.data.mapSetting) })
    this.setData({ settingsDirty: false })
    wx.showToast({ title: '已保存地图设置', icon: 'none' })
  },

  onResetSettings() {
    this._applyMapSetting(createBaseSetting(), { applyScale: true, refreshSlider: true })
    this._syncNativeMarkers()
  },

  onToggleSetting(e) {
    const key = e.currentTarget.dataset.key
    if (typeof this.data.mapSetting[key] !== 'boolean') return
    const next = { ...this.data.mapSetting, [key]: !this.data.mapSetting[key] }
    if (['showMarkers', 'showWash', 'showVeil'].includes(key)) {
      this.setData({ mapSetting: next, settingsDirty: true }, () => {
        if (key === 'showMarkers') this._syncNativeMarkers()
      })
      return
    }
    this._applyMapSetting(next)
  },

  onSlideSetting(e) {
    this._applyCameraSetting(e.currentTarget.dataset.key, Number(e.detail.value))
  },

  onNudgeSetting(e) {
    const { key, dir, step } = e.currentTarget.dataset
    const option = this.data.settingGroups.flatMap((group) => group.options).find((entry) => entry.key === key)
    if (!option || option.type !== 'range' || option.disabled) return
    const current = this.data.mapSetting[key]
    const delta = Number(dir) * (Number(step) || option.step)
    const value = Math.min(option.max, Math.max(option.min, current + delta))
    this._applyCameraSetting(key, value, true)
  },

  _applyCameraSetting(key, value, refreshSlider = false) {
    if (![...ZOOM_KEYS, 'rotate', 'skew'].includes(key) || !Number.isFinite(value)) return
    const current = this.data.mapSetting
    if (key === 'minScale') value = Math.min(value, current.maxScale - 1)
    if (key === 'maxScale') value = Math.max(value, current.minScale + 1)
    const next = sanitizeSetting({ ...current, [key]: value })
    if (next[key] === current[key]) return
    this._applyMapSetting(next, { applyScale: key === 'scale', refreshSlider })
  },

  _applyMapSetting(setting, { applyScale = false, refreshSlider = false } = {}) {
    const patch = { mapSetting: setting, settingsDirty: true }
    const current = this.data.mapSetting
    if (setting.minScale !== current.minScale || setting.maxScale !== current.maxScale) {
      patch.settingGroups = settingGroupsFor(setting)
    }
    const scale = applyScale ? setting.scale : clampZoom(this._viewScale, setting)
    if (applyScale || scale !== this._viewScale) {
      this._clearPinchTracking()
      this._stopScaleSampling()
      this._viewScale = scale
      patch.mapScale = scale
    }
    patch.nativeMapSetting = nativeMapSetting(setting, this._viewScale)
    this._appliedTilt = patch.nativeMapSetting.skew
    if (refreshSlider) patch.sliderSeed = this.data.sliderSeed + 1
    this.setData(patch)
  },

  async onRecenter() {
    this._viewportInteracted = true
    const loc = await this.getUserLocation()
    if (this.__mxhUnloaded) return
    if (!loc) {
      wx.showToast({ title: '定位失败，请检查权限', icon: 'none' })
      return
    }
    this._footprintLocation = loc
    this._stopCenterAnim()
    await this._centerOnUser(loc)
  },

  onShowAllFootprints() {
    if (this.__mxhUnloaded || !this._geoCards.length) return
    const items = this._geoCards.slice()
      .sort((a, b) => (b.shotAt || 0) - (a.shotAt || 0))
      .map((card) => this._bubbleFromCard(card))
    this.setData({
      bubble: null,
      bubbleGroup: null,
      detailCard: null,
      clusterSheet: { allFootprints: true, title: `足迹 · ${items.length} 只猫`, items }
    })
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
    const pending = false // 品种不再审核
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
      simulatedGeo: !!card.simulatedGeo,
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
        subtitle: '相邻足迹合并在一起，点开可切换查看',
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
    if (sheet && sheet.allFootprints) {
      const item = sheet.items.find((entry) => entry.id === id)
      if (item) this.setData({ detailCard: item })
      return
    }
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
  },

  /** 保存时没记地点的猫：单独一组列出来，可以查看或用当前位置补上 */
  onShowUnlocated() {
    if (this.__mxhUnloaded) return
    const located = new Set((this._geoCards || []).map((card) => card._id))
    const items = (this._footprintCards || [])
      .filter((card) => card && card._id && !located.has(card._id))
      .sort((a, b) => (b.shotAt || 0) - (a.shotAt || 0))
      .map((card) => this._bubbleFromCard(card))
      .filter(Boolean)
    if (!items.length) return
    this.setData({
      bubble: null,
      bubbleGroup: null,
      detailCard: null,
      clusterSheet: {
        allFootprints: true,
        unlocated: true,
        title: `未标注地点 · ${items.length} 只`,
        subtitle: '保存时没有记下地点。点一只查看，或者用你现在的位置补上（会模糊到街区）',
        items
      }
    })
  },

  /** 图鉴有猫但足迹不全时：再补一轮坐标 */
  async onRepairFootprints() {
    if (this._repairing) return
    this._repairing = true
    wx.showLoading({ title: '整理足迹…', mask: true })
    try {
      const loc = await this.getUserLocation()
      if (!loc) {
        wx.hideLoading()
        wx.showToast({ title: '请先开启定位权限', icon: 'none' })
        this._repairing = false
        return
      }
      const fill = await api.backfillMissingCardGeo({
        baseLoc: { latitude: loc.latitude, longitude: loc.longitude }
      })
      wx.hideLoading()
      const withGeo = ((fill && fill.footprintCards) || []).length
      const total = (fill && fill.total) || 0
      if (withGeo >= total && total > 0) {
        wx.showToast({ title: `已补齐 ${withGeo} 只猫的足迹`, icon: 'none' })
      } else if (withGeo > 0) {
        wx.showToast({ title: `已有足迹 ${withGeo}/${total} 只`, icon: 'none' })
      } else {
        wx.showToast({ title: '暂时没能补上足迹', icon: 'none' })
      }
      await this.load()
    } catch (e) {
      wx.hideLoading()
      wx.showToast({ title: '整理失败，请重试', icon: 'none' })
    }
    this._repairing = false
  }
})
