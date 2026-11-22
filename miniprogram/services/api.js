/**
 * 统一 API：写操作必须「本地 + 云端」双写；读操作云端优先并可与本地合并。
 * 约定：本地先落盘保证即时可见；云成功后 mirror 回本地；云失败保留本地，不丢操作。
 */
const local = require('./local-store')
const cache = require('./storage-cache')
const { appendIdentity } = require('../utils/photo-identity')
const { isEphemeralPath, persistLocalImage, sanitizeCardMedia } = require('../utils/card-media')
const {
  blurCoordinate,
  normalizeGeo,
  isValidGeo,
  spreadFootprints,
  geoCellKey,
  getCurrentPosition
} = require('../utils/geo-blur')

function pickGeo(cloudGeo, localGeo) {
  const cloud = normalizeGeo(cloudGeo)
  const local = normalizeGeo(localGeo)
  // 本地刚补点/散开时优先保留本地，避免云端旧坐标把多只又叠回一个点
  if (local && cloud) {
    if (local.lat !== cloud.lat || local.lng !== cloud.lng) return local
    return cloud
  }
  return local || cloud
}

let useCloud = false

function setCloudEnabled(enabled) {
  useCloud = !!enabled
}

async function callCloud(name, data = {}) {
  const res = await wx.cloud.callFunction({ name: 'api', data: { action: name, ...data } })
  const result = (res && res.result) || {}
  if (result.error) {
    const err = new Error(result.error)
    err.code = result.code || 'CLOUD_ERROR'
    throw err
  }
  return result
}

/** 读：云优先，失败回落本地 */
async function withFallback(action, localFn, payload) {
  if (useCloud) {
    try {
      return await callCloud(action, payload)
    } catch (e) {
      console.warn(`[api] cloud ${action} fail, fallback local`, e)
    }
  }
  return localFn(payload)
}

/**
 * 写：本地必写 + 云端同步。
 * afterCloud(cloudRes, localRes) 可把云结果镜像回本地并返回最终结果。
 */
async function dualWrite({ action, localWrite, cloudPayload, afterCloud }) {
  const localRes = await localWrite()
  if (!useCloud) return localRes
  try {
    const payload =
      typeof cloudPayload === 'function' ? (await cloudPayload(localRes)) || {} : cloudPayload || {}
    const cloudRes = await callCloud(action, payload)
    if (typeof afterCloud === 'function') {
      const merged = await afterCloud(cloudRes, localRes)
      return merged != null ? merged : cloudRes || localRes
    }
    return cloudRes || localRes
  } catch (e) {
    console.warn(`[api] cloud ${action} fail, keep local`, e)
    return localRes
  }
}

async function refreshCardCache() {
  try {
    cache.cacheCards((await listCards({})).cards || [])
  } catch (e) {
    /* ignore */
  }
}

async function login() {
  const res = await withFallback('login', () => local.login())
  // 云端真实 openid 与本地随机 local_* 对齐，避免卡还在却被 _openid 滤掉
  if (useCloud && res && res.openid) {
    try {
      const bound = local.bindCloudOpenId(res.openid)
      if (bound && (bound.rebound || bound.reclaimed)) {
        console.info('[api] rebound local cards to cloud openid', bound)
      }
    } catch (e) {
      console.warn('[api] bindCloudOpenId fail', e)
    }
  } else {
    // 纯本地也跑一遍认领
    try {
      await local.login()
    } catch (e) {
      /* ignore */
    }
  }
  if (res.user) cache.cacheUser(res.user)
  return res
}

async function getProfile() {
  const res = await withFallback('getProfile', () => local.getProfile())
  if (res.user) cache.cacheUser(res.user)
  return res
}

async function updateProfile(payload) {
  // 本地始终写入：否则「设为小屋展示」只写云端时，卡在本地/房间回退会空屋
  const localRes = await local.updateProfile(payload || {})
  let res = localRes
  if (useCloud) {
    try {
      const cloudRes = await callCloud('updateProfile', payload || {})
      if (cloudRes && cloudRes.user) res = cloudRes
    } catch (e) {
      console.warn('[api] cloud updateProfile fail, keep local', e)
    }
  }
  if (res.user) cache.cacheUser(res.user)
  return res
}

async function syncRoomProfile(user) {
  if (!user || !useCloud) return
  try {
    await callCloud('updateProfile', {
      displayCardId: user.displayCardId || '',
      roomMateIds: Array.isArray(user.roomMateIds) ? user.roomMateIds : []
    })
  } catch (e) {
    console.warn('[api] sync room profile fail, keep local', e)
  }
}

async function addCardToRoom(cardId, cardHint) {
  let ensured = await ensureLocalCard(cardId)
  if (!ensured && cardHint && cardHint._id) {
    try {
      const mirrored = await local.mirrorCloudCard(cardHint, {
        cutoutPath: cardHint.cutoutPath || '',
        originalPath: cardHint.originalPath || ''
      })
      ensured = (mirrored && mirrored.card) || cardHint
    } catch (e) {
      console.warn('[api] mirror hint card fail', e)
    }
  }
  if (!ensured) {
    const err = new Error('找不到这只猫')
    err.code = 'NOT_FOUND'
    throw err
  }
  const res = await local.addCardToRoom(cardId)
  if (res && res.user) {
    cache.cacheUser(res.user)
    await syncRoomProfile(res.user)
  }
  return res
}

async function removeCardFromRoom(cardId) {
  const res = await local.removeCardFromRoom(cardId)
  if (res && res.user) {
    cache.cacheUser(res.user)
    await syncRoomProfile(res.user)
  }
  return res
}

async function setRoomMain(cardId, cardHint) {
  let ensured = await ensureLocalCard(cardId)
  if (!ensured && cardHint && cardHint._id) {
    try {
      const mirrored = await local.mirrorCloudCard(cardHint, {
        cutoutPath: cardHint.cutoutPath || '',
        originalPath: cardHint.originalPath || ''
      })
      ensured = (mirrored && mirrored.card) || cardHint
    } catch (e) {
      console.warn('[api] mirror hint card fail', e)
    }
  }
  if (!ensured) {
    const err = new Error('找不到这只猫')
    err.code = 'NOT_FOUND'
    throw err
  }
  const res = await local.setRoomMain(cardId)
  if (res && res.user) {
    cache.cacheUser(res.user)
    await syncRoomProfile(res.user)
  }
  return res
}

async function recognize(payload) {
  // 腾讯品种 + rembg（内部可并行）；拍照页更推荐 rembg 与 recognizeBreedOnly 拆开以便先出预览
  const recognizeService = require('./recognize')
  const app = typeof getApp === 'function' ? getApp() : null
  const cloudReady = !!(app && app.globalData && app.globalData.cloudReady)
  return recognizeService.recognize({
    ...(payload || {}),
    useCloud: !!(cloudReady && useCloud)
  })
}

/** 只识别品种，不含抠图 */
async function recognizeBreedOnly(payload) {
  const recognizeService = require('./recognize')
  const app = typeof getApp === 'function' ? getApp() : null
  const cloudReady = !!(app && app.globalData && app.globalData.cloudReady)
  return recognizeService.recognizeBreedOnly({
    ...(payload || {}),
    useCloud: !!(cloudReady && useCloud)
  })
}

/** 只取 DetectPet 框，供裁猫 + rembg（不跑完整识别业务文案） */
async function detectPetBox(payload) {
  const recognizeService = require('./recognize')
  return recognizeService.detectPetBox(payload || {})
}

function preferPath(localPath, cloudPath) {
  // 临时路径不要盖掉可用的云路径/持久路径
  if (localPath && !isEphemeralPath(localPath)) return localPath
  if (cloudPath && !isEphemeralPath(cloudPath)) return cloudPath
  return localPath || cloudPath || ''
}

function isWeakBreedLabel(breed) {
  const b = String(breed || '').trim()
  return !b || b === '待识别' || b === '识别中…' || b === '未知小动物'
}

function mergeBreedReviewFields(cloudCard, localCard) {
  const cloudStatus = (cloudCard && cloudCard.breedReviewStatus) || ''
  const localStatus = (localCard && localCard.breedReviewStatus) || ''
  // 本地刚审结、云端还挂 pending：以本地为准，否则品种会被冲回「待识别」
  if (
    (localStatus === 'approved' || localStatus === 'rejected') &&
    (cloudStatus === 'pending' || !cloudStatus)
  ) {
    return {
      pendingBreed: localCard.pendingBreed || '',
      breedReviewStatus: localStatus,
      breedReviewId: localCard.breedReviewId || ''
    }
  }
  // 云端已审结优先
  if (cloudStatus === 'approved' || cloudStatus === 'rejected') {
    return {
      pendingBreed: cloudCard.pendingBreed || '',
      breedReviewStatus: cloudStatus,
      breedReviewId: cloudCard.breedReviewId || ''
    }
  }
  if (cloudStatus === 'pending' || localStatus === 'pending') {
    const src = cloudStatus === 'pending' ? cloudCard : localCard
    return {
      pendingBreed: (src && src.pendingBreed) || localCard.pendingBreed || cloudCard.pendingBreed || '',
      breedReviewStatus: 'pending',
      breedReviewId:
        (src && src.breedReviewId) || localCard.breedReviewId || cloudCard.breedReviewId || ''
    }
  }
  return {
    pendingBreed: (cloudCard && cloudCard.pendingBreed) || (localCard && localCard.pendingBreed) || '',
    breedReviewStatus: cloudStatus || localStatus || '',
    breedReviewId: (cloudCard && cloudCard.breedReviewId) || (localCard && localCard.breedReviewId) || ''
  }
}

function mergeCardLists(cloudCards, localCards) {
  const map = {}
  // 本地已放生的卡：云端放生失败时云上还在，不能让它「回来」
  const released = {}
  try {
    local.releasedCardIds().forEach((id) => {
      released[id] = true
    })
  } catch (e) {
    /* ignore */
  }
  // 云端卡的 clientId = 当初本地 card_* id；超时没来得及换 id 时据此去重
  const cloudByClientId = {}
  ;(cloudCards || []).forEach((c) => {
    if (c && c.clientId) cloudByClientId[c.clientId] = c
  })
  ;(localCards || []).forEach((c) => {
    if (!c || !c._id) return
    const twin = cloudByClientId[c._id]
    if (twin) {
      try {
        local.rekeyCard(c._id, twin._id)
      } catch (e) {
        /* ignore */
      }
      map[twin._id] = { ...c, _id: twin._id }
      return
    }
    map[c._id] = c
  })
  // 云端覆盖同 id；本地独有（云端建卡失败时）仍保留
  ;(cloudCards || []).forEach((c) => {
    if (!c || !c._id) return
    if (released[c._id]) return
    const localCard = map[c._id]
    if (!localCard) {
      map[c._id] = c
      return
    }
    const review = mergeBreedReviewFields(c, localCard)
    // 本地已通过且有有效品种，云端仍是待识别/挂审：保住本地品种
    const preferLocalBreed =
      localCard.breedReviewStatus === 'approved' &&
      !isWeakBreedLabel(localCard.breed) &&
      (c.breedReviewStatus === 'pending' || isWeakBreedLabel(c.breed))
    map[c._id] = {
      ...c,
      cutoutPath: preferPath(localCard.cutoutPath, c.cutoutPath),
      originalPath: preferPath(localCard.originalPath, c.originalPath),
      cutoutFileId: c.cutoutFileId || localCard.cutoutFileId || '',
      originalFileId: c.originalFileId || localCard.originalFileId || '',
      ...review,
      breed: preferLocalBreed ? localCard.breed : c.breed || localCard.breed,
      confidence: preferLocalBreed
        ? localCard.confidence || c.confidence || 0
        : c.confidence != null
          ? c.confidence
          : localCard.confidence || 0,
      photoIdentities: (localCard.photoIdentities || []).reduce(
        (refs, identity) => appendIdentity(refs, identity),
        c.photoIdentities || []
      ),
      geo: pickGeo(c.geo, localCard.geo)
    }
  })
  return Object.keys(map)
    .map((id) => {
      const card = map[id]
      const geo = normalizeGeo(card && card.geo)
      return geo ? { ...card, geo } : { ...card, geo: null }
    })
    .sort((a, b) => (b.shotAt || 0) - (a.shotAt || 0))
}

let _repairTried = false

async function listCards(payload = {}) {
  const breed = payload && payload.breed
  const filterByBreed = breed && breed !== '全部'
  try {
    // 本地与云并行，避免「先本地再干等云函数」
    const localPromise = local.listCards(payload)
    const cloudPromise = useCloud
      ? callCloud('listCards', payload || {}).catch((e) => {
          console.warn('[api] cloud listCards fail, use local', e)
          return null
        })
      : Promise.resolve(null)

    const [localRes, cloudRes] = await Promise.all([localPromise, cloudPromise])
    let cloudCards = cloudRes && Array.isArray(cloudRes.cards) ? cloudRes.cards : null

    // 孤儿修复只试一次（会话内），避免每次进图鉴都扫库
    if (
      useCloud &&
      !_repairTried &&
      cloudCards &&
      !cloudCards.length &&
      !(localRes.cards || []).length
    ) {
      _repairTried = true
      try {
        const repairedFlag = wx.getStorageSync('mxh_orphan_repaired')
        if (!repairedFlag) {
          const repair = await callCloud('repairOrphanCards', {})
          wx.setStorageSync('mxh_orphan_repaired', 1)
          if (repair && repair.count > 0) {
            console.info('[api] repaired orphan cards', repair)
            const again = await callCloud('listCards', payload || {})
            cloudCards = (again && again.cards) || []
          }
        }
      } catch (re) {
        console.warn('[api] repairOrphanCards fail', re)
      }
    }

    const cards =
      cloudCards == null
        ? localRes.cards || []
        : mergeCardLists(cloudCards, localRes.cards || [])
    const filtered = (
      filterByBreed ? cards.filter((c) => c.breed === breed) : cards
    ).map(sanitizeCardMedia)
    if (!filterByBreed) cache.cacheCards(filtered)
    return { cards: filtered, fromCache: false }
  } catch (e) {
    const cards = cache.getCachedCards() || []
    return { cards: filterByBreed ? cards.filter((c) => c.breed === breed) : cards, fromCache: true }
  }
}

async function repairOrphanCards() {
  if (!useCloud) return { count: 0, repaired: [] }
  _repairTried = true
  const res = await callCloud('repairOrphanCards', {})
  try {
    wx.setStorageSync('mxh_orphan_repaired', 1)
  } catch (e) {
    /* ignore */
  }
  return res
}

async function getCard(cardId) {
  // 云端返回 { card: null } 时不会抛错，必须再读本地，否则「保存成功却提示卡牌不存在」
  if (useCloud) {
    try {
      const res = await callCloud('getCard', { cardId })
      if (res && res.card) return res
    } catch (e) {
      console.warn('[api] cloud getCard fail, fallback local', e)
    }
  }
  return local.getCard(cardId)
}

async function uploadLocalImageToCloud(filePath, folder) {
  if (!filePath) return ''
  let src = String(filePath)
  if (src.indexOf('cloud://') === 0) return src
  // 127.0.0.1/__tmp__ 不能直接 uploadFile，先落到 USER_DATA_PATH
  try {
    const persisted = await persistLocalImage(src)
    if (persisted && !isEphemeralPath(persisted)) src = persisted
  } catch (e) {
    console.warn('[api] persist before upload fail', e)
  }
  if (isEphemeralPath(src) && /^https?:\/\//i.test(src)) {
    // 仍是 http 临时链：再试一次 download
    try {
      const again = await persistLocalImage(src)
      if (again && !isEphemeralPath(again)) src = again
    } catch (e) {
      /* ignore */
    }
  }
  if (!src || (isEphemeralPath(src) && /^https?:\/\//i.test(src))) {
    console.warn('[api] skip upload, no stable local file', src)
    return ''
  }
  const cloudPath = `${folder}/${Date.now()}_${Math.random().toString(16).slice(2)}.png`
  return new Promise((resolve) => {
    wx.cloud.uploadFile({
      cloudPath,
      filePath: src,
      success: (res) => resolve(res.fileID || ''),
      fail: (err) => {
        console.warn('[api] upload card image fail', err)
        resolve('')
      }
    })
  })
}

async function createCard(payload) {
  let nextGeo = normalizeGeo(payload && payload.geo)
  if (!nextGeo) {
    const err = new Error('需要位置信息才能记录相遇')
    err.code = 'GEO_REQUIRED'
    throw err
  }
  // 模糊到街区后，按同街区已有猫散开，避免地图永远叠成 1 个点
  nextGeo = blurCoordinate(nextGeo.lat, nextGeo.lng)
  try {
    const listed = await listCards({})
    const cell = geoCellKey(nextGeo.lat, nextGeo.lng)
    const siblings = (listed.cards || []).filter((c) => {
      const g = normalizeGeo(c && c.geo)
      return g && geoCellKey(g.lat, g.lng) === cell
    })
    nextGeo =
      spreadFootprints(nextGeo.lat, nextGeo.lng, siblings.length, siblings.length + 1) || nextGeo
  } catch (e) {
    /* ignore spread fail */
  }
  // 临时抠图落到用户目录，避免重启/清缓存后图鉴空白
  const [cutoutPath, originalPath] = await Promise.all([
    persistLocalImage(payload.cutoutPath),
    persistLocalImage(payload.originalPath)
  ])
  const localPayload = {
    ...(payload || {}),
    geo: nextGeo,
    cutoutPath: cutoutPath || payload.cutoutPath || '',
    originalPath: originalPath || payload.originalPath || ''
  }

  // 双写约定：本地先写（界面立刻可用），云端成功后把本地 card_* 换成云端 id
  let res = await local.createCard(localPayload)
  const localCardId = res && res.card && res.card._id
  if (useCloud) {
    try {
      const [cutoutFileId, originalFileId] = await Promise.all([
        uploadLocalImageToCloud(localPayload.cutoutPath, 'cards/cutout'),
        uploadLocalImageToCloud(localPayload.originalPath, 'cards/original')
      ])
      const cloudRes = await callCloud('createCard', {
        ...localPayload,
        clientId: localCardId || '',
        cutoutFileId: cutoutFileId || localPayload.cutoutFileId || '',
        originalFileId: originalFileId || localPayload.originalFileId || '',
        // 云端 path 字段尽量存 fileID，便于纯云端展示
        cutoutPath: cutoutFileId || localPayload.cutoutPath || '',
        originalPath: originalFileId || localPayload.originalPath || ''
      })
      if (cloudRes && cloudRes.card && cloudRes.card._id) {
        try {
          // 先换 id（连带记忆/审核/小屋引用），再用云端字段覆盖本地镜像
          local.rekeyCard(localCardId, cloudRes.card._id)
          // 本地仍是临时链时不要写入镜像，改用云 fileID
          const localCut =
            localPayload.cutoutPath && !isEphemeralPath(localPayload.cutoutPath)
              ? localPayload.cutoutPath
              : ''
          const localOrig =
            localPayload.originalPath && !isEphemeralPath(localPayload.originalPath)
              ? localPayload.originalPath
              : ''
          const mirrored = await local.mirrorCloudCard(cloudRes.card, {
            cutoutPath: localCut || cutoutFileId || '',
            originalPath: localOrig || originalFileId || ''
          })
          res = { ...cloudRes, card: (mirrored && mirrored.card) || cloudRes.card }
          if (res.card.breedReviewStatus === 'pending' || res.card.pendingBreed) {
            local.upsertBreedReview({
              _id: res.card.breedReviewId || '',
              cardId: res.card._id,
              fromBreed: res.card.breed || '',
              toBreed: res.card.pendingBreed || '',
              recognizedBreed: res.card.recognizedBreed || '',
              status: 'pending',
              createdAt: res.card.createdAt || Date.now()
            })
          }
        } catch (e) {
          console.warn('[api] mirrorCloudCard fail', e)
        }
      }
    } catch (e) {
      // 云失败：保留本地结果，不回滚用户可见状态
      console.warn('[api] cloud createCard fail, keep local', e)
    }
  }
  // 刷新缓存
  try {
    const list = await listCards({})
    cache.cacheCards(list.cards)
  } catch (e) {
    /* ignore */
  }
  return res
}

/** 保证本地有这张卡的镜像（云端列表出来的卡可能尚未落本地） */
async function ensureLocalCard(cardId) {
  if (!cardId) return null
  try {
    const localHit = await local.getCard(cardId)
    if (localHit && localHit.card) return localHit.card
  } catch (e) {
    /* ignore */
  }
  if (useCloud) {
    try {
      const cloudRes = await callCloud('getCard', { cardId })
      if (cloudRes && cloudRes.card) {
        const mirrored = await local.mirrorCloudCard(cloudRes.card, {
          cutoutPath: cloudRes.card.cutoutPath || '',
          originalPath: cloudRes.card.originalPath || ''
        })
        return (mirrored && mirrored.card) || cloudRes.card
      }
    } catch (e) {
      console.warn('[api] ensureLocalCard cloud fail', e)
    }
  }
  // 列表缓存兜底
  const cached = (cache.getCachedCards() || []).find((c) => c && c._id === cardId)
  if (cached) {
    try {
      const mirrored = await local.mirrorCloudCard(cached, {
        cutoutPath: cached.cutoutPath || '',
        originalPath: cached.originalPath || ''
      })
      return (mirrored && mirrored.card) || cached
    } catch (e) {
      return cached
    }
  }
  return null
}

async function updateCard(cardId, patch, { requireCloudWrite = false } = {}) {
  // 云端合并出来的卡可能不在本地：先镜像再改
  await ensureLocalCard(cardId)
  // 禁止客户端直接改品种，统一走 requestBreedChange
  const safePatch = { ...(patch || {}) }
  if (safePatch.breed !== undefined && !safePatch._breedReviewApply) {
    delete safePatch.breed
  }

  if (requireCloudWrite) {
    if (!useCloud) return local.updateCard(cardId, safePatch)
    const cloudRes = await callCloud('updateCard', { cardId, patch: safePatch })
    if (!cloudRes.card) throw new Error('云端未返回更新后的猫卡')
    const { card } = cloudRes
    try {
      const localRes = await local.getCard(cardId)
      await local.mirrorCloudCard(card, (localRes && localRes.card) || {})
    } catch (err) {
      console.warn('[api] updateCard local mirror fail', err)
    }
    return cloudRes
  }

  let localRes = null
  try {
    localRes = await local.updateCard(cardId, safePatch)
  } catch (e) {
    console.warn('[api] local updateCard', e)
  }
  let res = localRes
  if (useCloud) {
    try {
      const cloudRes = await callCloud('updateCard', { cardId, patch: safePatch })
      if (cloudRes && cloudRes.card) {
        // 刚写入的 geo 以本地补丁为准，防止镜像把散开坐标冲掉
        const mirroredCard = {
          ...cloudRes.card,
          geo:
            safePatch.geo !== undefined
              ? normalizeGeo(safePatch.geo) || normalizeGeo(cloudRes.card.geo)
              : pickGeo(cloudRes.card.geo, localRes && localRes.card && localRes.card.geo)
        }
        res = { ...cloudRes, card: mirroredCard }
        try {
          await local.mirrorCloudCard(mirroredCard, {
            cutoutPath: (safePatch && safePatch.cutoutPath) || mirroredCard.cutoutPath || '',
            originalPath: (safePatch && safePatch.originalPath) || mirroredCard.originalPath || ''
          })
        } catch (me) {
          /* ignore */
        }
      } else if (cloudRes && cloudRes.error) {
        throw new Error(cloudRes.error)
      }
    } catch (e) {
      console.warn('[api] cloud updateCard fail, keep local', e)
    }
  }
  if (!res || !res.card) {
    if (localRes && localRes.card) return localRes
    throw new Error('更新失败')
  }
  if (res.card && res.card.geo) {
    res.card.geo = normalizeGeo(res.card.geo)
  }
  try {
    const list = await listCards({})
    cache.cacheCards(list.cards)
  } catch (e) {
    /* ignore */
  }
  return res
}

async function requestBreedChange(cardId, breed) {
  await ensureLocalCard(cardId)
  const res = await dualWrite({
    action: 'requestBreedChange',
    localWrite: () => local.requestBreedChange(cardId, breed),
    cloudPayload: { cardId, breed },
    afterCloud: async (cloudRes, localRes) => {
      const card = {
        ...(cloudRes.card || localRes.card || {}),
        pendingBreed:
          (cloudRes.card && cloudRes.card.pendingBreed) ||
          (localRes.card && localRes.card.pendingBreed) ||
          breed,
        breedReviewStatus:
          (cloudRes.card && cloudRes.card.breedReviewStatus) ||
          (localRes.card && localRes.card.breedReviewStatus) ||
          'pending',
        breedReviewId:
          (cloudRes.card && cloudRes.card.breedReviewId) ||
          (localRes.card && localRes.card.breedReviewId) ||
          ''
      }
      await local.mirrorCloudCard(card, {
        cutoutPath: card.cutoutPath || '',
        originalPath: card.originalPath || ''
      })
      local.upsertBreedReview({
        _id: card.breedReviewId || (localRes.review && localRes.review._id) || '',
        cardId,
        fromBreed: (localRes.review && localRes.review.fromBreed) || card.breed || '',
        toBreed: card.pendingBreed || breed,
        recognizedBreed: card.recognizedBreed || '',
        status: 'pending',
        createdAt: (localRes.review && localRes.review.createdAt) || Date.now()
      })
      return { ...(cloudRes || {}), ...(localRes || {}), card, toast: (cloudRes && cloudRes.toast) || (localRes && localRes.toast) }
    }
  })
  await refreshCardCache()
  return res
}

async function reviewBreedChange(payload) {
  const body = payload || {}
  const approve = !!body.approve
  const res = await dualWrite({
    action: 'reviewBreedChange',
    localWrite: () => local.reviewBreedChange(body),
    cloudPayload: (localRes) => ({
      ...body,
      cardId: body.cardId || (localRes.card && localRes.card._id) || '',
      approve,
      approveBreed: approve && localRes.card ? localRes.card.breed : ''
    }),
    afterCloud: async (cloudRes, localRes) => {
      const localCard = localRes && localRes.card
      let card = { ...(cloudRes.card || localCard || {}) }
      if (isWeakBreedLabel(card.breed) && localCard && !isWeakBreedLabel(localCard.breed)) {
        card.breed = localCard.breed
        card.confidence = localCard.confidence || 100
      }
      card.pendingBreed = ''
      card.breedReviewStatus = approve ? 'approved' : 'rejected'
      card.breedReviewId = ''
      await local.mirrorCloudCard(card, {
        cutoutPath: card.cutoutPath || '',
        originalPath: card.originalPath || ''
      })
      local.upsertBreedReview({
        _id: body.reviewId || '',
        cardId: card._id || body.cardId,
        toBreed: card.breed || '',
        status: approve ? 'approved' : 'rejected',
        reviewedAt: Date.now()
      })
      return {
        ...(localRes || {}),
        ...(cloudRes || {}),
        card,
        toast: (cloudRes && cloudRes.toast) || (localRes && localRes.toast)
      }
    }
  })
  if (res && res.card) {
    local.upsertBreedReview({
      _id: body.reviewId || '',
      cardId: res.card._id || body.cardId,
      toBreed: res.card.breed || '',
      status: approve ? 'approved' : 'rejected',
      reviewedAt: Date.now()
    })
  }
  await refreshCardCache()
  return res
}

async function listBreedReviews(payload) {
  const localRes = await local.listBreedReviews(payload || {})
  let cloudList = null
  if (useCloud) {
    try {
      const cloudRes = await callCloud('listBreedReviews', payload || {})
      if (cloudRes && Array.isArray(cloudRes.list)) cloudList = cloudRes.list
    } catch (e) {
      console.warn('[api] cloud listBreedReviews fail, use local', e)
    }
  }
  // 云端空列表不能盖掉本地待审（集合未建、函数未部署、openid 未对齐时常见）
  const map = {}
  ;(localRes.list || []).forEach((r) => {
    if (!r) return
    const key = r._id || `${r.cardId}_${r.toBreed}_${r.createdAt || 0}`
    map[key] = r
  })
  ;(cloudList || []).forEach((r) => {
    if (!r) return
    const key = r._id || `${r.cardId}_${r.toBreed}_${r.createdAt || 0}`
    map[key] = { ...(map[key] || {}), ...r }
    // 云端审核单同步进本地，保证下次离线也能审/能见
    try {
      local.upsertBreedReview(map[key])
    } catch (e) {
      /* ignore */
    }
  })
  let list = Object.keys(map).map((k) => map[k])
  const status = payload && payload.status
  if (status) list = list.filter((r) => r && r.status === status)
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return { list }
}

/** 给丢图的卡补一张图：本地持久化 + 云上传 */
async function reattachCardImage(cardId, filePath) {
  if (!cardId || !filePath) throw new Error('缺少图片')
  const ensured = await ensureLocalCard(cardId)
  if (!ensured) throw new Error('找不到这张卡')

  const localPath = await persistLocalImage(filePath)
  let stable = localPath && !isEphemeralPath(localPath) ? localPath : ''
  if (!stable) {
    // chooseMedia 的 tempFilePath 再拷一次
    const again = await persistLocalImage(filePath)
    stable = again && !isEphemeralPath(again) ? again : filePath
  }

  let cutoutFileId = ''
  if (useCloud) {
    cutoutFileId = await uploadLocalImageToCloud(stable, 'cards/cutout')
  }
  // 本地路径优先用于开发者工具展示；云 fileID 双写
  const patch = {
    cutoutPath: (!isEphemeralPath(stable) && stable) || cutoutFileId || stable,
    originalPath: (!isEphemeralPath(stable) && stable) || cutoutFileId || stable,
    cutoutFileId: cutoutFileId || '',
    originalFileId: cutoutFileId || '',
    mattingFailed: true
  }
  const res = await updateCard(cardId, patch)
  if (!res || !res.card) throw new Error('补图保存失败')
  return res
}

/** 按 _id 合并：云端覆盖同 id，本地独有（云写失败时）保留；云端空列表不会清掉本地 */
function mergeById(cloudList, localList) {
  const map = {}
  ;(localList || []).forEach((x) => {
    if (x && x._id) map[x._id] = x
  })
  ;(cloudList || []).forEach((x) => {
    if (x && x._id) map[x._id] = { ...(map[x._id] || {}), ...x }
  })
  return Object.keys(map).map((k) => map[k])
}

async function listMemories(cardId) {
  const localRes = await local.listMemories(cardId)
  if (!useCloud) return localRes
  try {
    const cloudRes = await callCloud('listMemories', { cardId })
    const memories = mergeById(cloudRes && cloudRes.memories, localRes.memories).sort(
      (a, b) => (a.createdAt || 0) - (b.createdAt || 0)
    )
    return { memories }
  } catch (e) {
    console.warn('[api] cloud listMemories fail, use local', e)
    return localRes
  }
}

let embeddingUnavailable = false

function canEmbedCatPhoto() {
  return useCloud && !embeddingUnavailable
}

async function embedCatPhoto(imageBase64) {
  if (!canEmbedCatPhoto() || !imageBase64) return ''
  try {
    const result = await callCloud('embedCatPhoto', { imageBase64 })
    if (result.code === 'DISABLED') embeddingUnavailable = true
    return result.embedding || ''
  } catch (e) {
    if (e && e.code === 'BAD_ACTION') embeddingUnavailable = true
    return ''
  }
}

async function createMemory(payload) {
  await ensureLocalCard(payload && payload.cardId)
  const imagePath = await persistLocalImage(payload.imagePath)
  const input = { ...payload, imagePath }
  return dualWrite({
    action: 'createMemory',
    localWrite: () => local.createMemory(input),
    cloudPayload: async () => ({
      ...input,
      imagePath: '',
      imageFileId: await uploadLocalImageToCloud(imagePath, 'memories/photos')
    }),
    afterCloud: async (cloudRes, localRes) => {
      const localId = localRes && localRes.memory && localRes.memory._id
      if (cloudRes && cloudRes.memory && localId) {
        const re = await local.rekeyMemory(localId, cloudRes.memory)
        if (re && re.memory) return { memory: re.memory }
      }
      return cloudRes || localRes
    }
  })
}

async function deleteMemory(memoryId) {
  return dualWrite({
    action: 'deleteMemory',
    localWrite: () => local.deleteMemory(memoryId),
    cloudPayload: { memoryId },
    afterCloud: (cloudRes, localRes) => ({
      ...(localRes || {}),
      ...(cloudRes || {}),
      cardId: (cloudRes && cloudRes.cardId) || (localRes && localRes.cardId) || ''
    })
  })
}

async function reportDuelResult(payload) {
  return dualWrite({
    action: 'reportDuelResult',
    localWrite: () => local.reportDuelResult(payload),
    cloudPayload: payload || {}
  })
}

function filtersFromCards(cards) {
  const counts = {}
  ;(cards || []).forEach((c) => {
    const breed = (c && c.breed) || '待识别'
    counts[breed] = (counts[breed] || 0) + 1
  })
  return Object.keys(counts)
    .map((breed) => ({ breed, count: counts[breed] }))
    .sort((a, b) => b.count - a.count)
}

async function breedFilters(cardsMaybe) {
  // 优先用已有列表现算，禁止再打一遍 listCards
  if (Array.isArray(cardsMaybe)) {
    return { filters: filtersFromCards(cardsMaybe) }
  }
  const cached = cache.getCachedCards()
  if (cached && cached.length) {
    return { filters: filtersFromCards(cached) }
  }
  try {
    return { filters: local.breedFilters() }
  } catch (e) {
    return { filters: [] }
  }
}

let lastCloudRoom = null

async function getCloudRoomState() {
  try {
    const room = await callCloud('getRoomState', {})
    lastCloudRoom = room
    return room
  } catch (err) {
    console.warn('[api] cloud getRoomState fail', err)
  }

  try {
    const { user } = await callCloud('getProfile', {})
    if (user) {
      const outing = user.outing || {}
      const away = outing.status === 'out' || outing.status === 'visiting'
      return {
        user,
        myCatStatus: away ? 'away' : user.displayCardId ? 'home' : 'none',
        outingPhase: away ? outing.status : user.displayCardId ? 'home' : 'none',
        outingCardId: away ? outing.cardId || user.displayCardId || '' : '',
        outingCatName: '',
        visitor: null,
        leftTrace: null,
        unreadBadge: outing.unreadReport ? 1 : 0,
        unreadReport: outing.unreadReport || null,
        autoShowReport: false
      }
    }
  } catch (err) {
    console.warn('[api] cloud room profile fail', err)
  }
  return lastCloudRoom
}

async function getRoomState() {
  const [localRoom, cloudRes] = await Promise.all([
    local.getRoomState({ cloudMode: useCloud }),
    useCloud ? getCloudRoomState() : null
  ])
  const localTrip = localRoom.outingCardId.startsWith('card_') && !(cloudRes && cloudRes.outingCardId)
  const localOuting = localTrip ? {
    myCatStatus: localRoom.myCatStatus,
    outingPhase: localRoom.outingPhase,
    outingCardId: localRoom.outingCardId,
    outingCatName: localRoom.outingCatName
  } : {}

  // 云模式下出门和访客都以云端状态为准。
  let res = cloudRes
    ? {
        ...localRoom,
        ...cloudRes,
        user: {
          ...(localRoom.user || {}),
          ...(cloudRes.user || {}),
          displayCardId:
            (cloudRes.user && cloudRes.user.displayCardId) ||
            (localRoom.user && localRoom.user.displayCardId) ||
            '',
          roomMateIds: [
            ...((cloudRes.user && cloudRes.user.roomMateIds) || []),
            ...((localRoom.user && localRoom.user.roomMateIds) || []).filter((id) => id.startsWith('card_'))
          ]
        },
        displayCard: cloudRes.displayCard || localRoom.displayCard || null,
        care: localRoom.care,
        careBars: localRoom.careBars,
        furniture: localRoom.furniture,
        ...localOuting
      }
    : useCloud
      ? {
          ...localRoom,
          myCatStatus: localRoom.displayCard ? 'home' : 'none',
          outingPhase: localRoom.displayCard ? 'home' : 'none',
          outingCardId: '',
          outingCatName: '',
          visitor: null,
          leftTrace: null,
          unreadBadge: 0,
          unreadReport: null,
          autoShowReport: false,
          ...localOuting
        }
      : localRoom

  const displayId = res && res.user && res.user.displayCardId
  if (displayId && res.displayCard && res.displayCard._id !== displayId) res.displayCard = null
  if (displayId && !res.displayCard) {
    try {
      const localCard = await local.getCard(displayId)
      if (localCard && localCard.card) {
        res = {
          ...res,
          displayCard: localCard.card,
          myCatStatus:
            res.myCatStatus && res.myCatStatus !== 'none' ? res.myCatStatus : 'home'
        }
      }
    } catch (e) {
      console.warn('[api] fill displayCard from local fail', e)
    }
  }

  if (res.displayCard && (!res.myCatStatus || res.myCatStatus === 'none')) {
    res.myCatStatus =
      localRoom.myCatStatus && localRoom.myCatStatus !== 'none'
        ? localRoom.myCatStatus
        : 'home'
  }

  return res
}

async function careCat(payload) {
  // 护理状态优先本地，保证离线衰减与互动即时；亲密度同步云端
  if (payload && payload.cardId && lastCloudRoom && lastCloudRoom.outingCardId === payload.cardId) {
    const err = new Error('它还在外面呢')
    err.code = 'CAT_AWAY'
    throw err
  }
  const res = await local.careCat({ ...(payload || {}), useCloudOuting: useCloud })
  if (res && res.user) {
    cache.cacheUser(res.user)
    syncRoomProfile(res.user)
  }
  if (res && res.cardId && res.intimacyPatch) {
    try {
      await updateCard(res.cardId, res.intimacyPatch)
    } catch (e) {
      console.warn('[api] sync intimacy fail, keep local', e)
    }
  }
  return res
}

async function saveRoomFurniture(payload) {
  return local.saveRoomFurniture(payload || {})
}

async function interactVisitor({ visitId, action, source } = {}) {
  return useCloud && source !== 'local'
    ? callCloud('interactVisitor', { visitId, interaction: action })
    : local.interactVisitor({ visitId, action })
}

async function dismissReport(payload = {}) {
  return dualWrite({
    action: 'dismissReport',
    localWrite: () => local.dismissReport(payload),
    cloudPayload: payload || {}
  })
}

async function dismissLeftTrace(payload) {
  return dualWrite({
    action: 'dismissLeftTrace',
    localWrite: () => local.dismissLeftTrace(payload),
    cloudPayload: payload || {}
  })
}

async function listOutingLogs(payload) {
  // 不能用 withFallback：云端空列表会盖掉本地有效记录
  const localRes = await local.listOutingLogs(payload)
  if (!useCloud) return localRes
  try {
    const cloudRes = await callCloud('listOutingLogs', payload)
    const cloudLogs = (cloudRes && cloudRes.logs) || []
    if (!cloudLogs.length) return localRes
    const logs = mergeById(cloudLogs, localRes.logs).sort(
      (a, b) => (b.returnedAt || 0) - (a.returnedAt || 0)
    )
    return { logs }
  } catch (e) {
    console.warn('[api] cloud listOutingLogs fail, use local', e)
    return localRes
  }
}

async function listVisitLogs(payload = {}) {
  const localRes = await local.listVisitLogs(payload || {})
  if (!useCloud) return localRes
  try {
    const cloudRes = await callCloud('listVisitLogs', payload || {})
    const cloudLogs = (cloudRes && cloudRes.logs) || []
    if (!cloudLogs.length) return localRes
    const map = {}
    ;(localRes.logs || []).forEach((l) => {
      if (!l) return
      const key = l.visitId || l._id || `${l.direction}_${l.at}`
      map[key] = l
    })
    cloudLogs.forEach((l) => {
      if (!l) return
      const key = l.visitId || l._id || `${l.direction}_${l.at}`
      map[key] = { ...(map[key] || {}), ...l }
    })
    const logs = Object.keys(map)
      .map((k) => map[k])
      .sort((a, b) => (b.at || 0) - (a.at || 0))
    return { logs }
  } catch (e) {
    console.warn('[api] listVisitLogs cloud fail', e)
    return localRes
  }
}

async function debugAdvanceOuting() {
  // 仅本地加速验收
  return local.debugAdvanceOuting()
}

async function releaseCard(cardId) {
  if (!cardId) throw new Error('缺少猫卡')
  let res
  if (useCloud && !String(cardId).startsWith('card_')) {
    res = await callCloud('releaseCard', { cardId })
    if (!res.released) throw new Error('放生失败，请确认云函数已更新')
    try {
      lastCloudRoom = null
      const localRes = await local.releaseCard(cardId, res.released, res.room)
      cache.cacheUser(localRes.user)
    } catch (e) {
      console.warn('[api] mirror released card fail', e)
    }
  } else {
    res = await local.releaseCard(cardId)
    if (res.user) cache.cacheUser(res.user)
  }
  await refreshCardCache()
  return res
}

async function listMyReleased() {
  const localRes = await local.listMyReleased()
  if (!useCloud) return localRes
  try {
    const cloudRes = await callCloud('listMyReleased', {})
    const cloudList = (cloudRes && cloudRes.list) || []
    const map = {}
    ;(localRes.list || []).forEach((r) => {
      if (!r) return
      const key = r.cardId || r._id
      map[key] = r
    })
    cloudList.forEach((c) => {
      if (!c) return
      const key = c.cardId || c._id
      const hit = map[key]
      map[key] = {
        ...(hit || {}),
        ...c,
        cutoutPath: (hit && hit.cutoutPath) || c.cutoutFileId || c.cutoutPath || '',
        statusLabel: c.statusLabel || (hit && hit.statusLabel) || '',
        statusTone: c.statusTone || c.status || (hit && hit.statusTone) || 'wandering'
      }
    })
    const list = Object.keys(map)
      .map((k) => map[k])
      .sort((a, b) => (b.releasedAt || 0) - (a.releasedAt || 0))
    return { list }
  } catch (e) {
    console.warn('[api] listMyReleased cloud fail', e)
    return localRes
  }
}

async function adoptVisitor({ visitId, geo, placeText, source } = {}) {
  const payload = { visitId, geo, placeText }
  const useCloudVisit = useCloud && source !== 'local'
  const res = useCloudVisit
    ? await callCloud('adoptVisitor', payload)
    : await local.adoptVisitor(payload)
  if (useCloudVisit && res.card) {
    lastCloudRoom = null
    try {
      await local.mirrorCloudCard(res.card)
    } catch (e) {
      console.warn('[api] mirror adopted card fail', e)
    }
  }
  await refreshCardCache()
  return res
}

/**
 * 给缺坐标的旧卡补定位，并把叠在同一模糊点上的多只猫散开。
 * 返回整理后的卡片（含规范化 geo），供足迹页直接使用，避免再被云端旧坐标盖掉。
 */
async function backfillMissingCardGeo(options = {}) {
  const { cards } = await listCards({})
  const real = (cards || [])
    .filter((c) => c && c._id && String(c._id).indexOf('debug_') !== 0)
    .map((c) => {
      const geo = normalizeGeo(c.geo)
      return { ...c, geo }
    })

  const missing = real.filter((c) => !c.geo)
  let updated = 0
  let needAuth = false

  if (missing.length) {
    // 足迹页可传入已拿到的定位，避免二次 getLocation 失败导致补不齐
    const hinted = options.baseLoc || null
    const loc =
      hinted &&
      Number.isFinite(Number(hinted.latitude)) &&
      Number.isFinite(Number(hinted.longitude))
        ? { latitude: Number(hinted.latitude), longitude: Number(hinted.longitude) }
        : await getCurrentPosition()
    const withGeoNow = real.filter((c) => c.geo)
    let base = null
    if (loc) {
      base = blurCoordinate(loc.latitude, loc.longitude)
    } else if (withGeoNow.length) {
      // 无定位时，围着已有足迹补，避免整页只剩 1 只
      base = blurCoordinate(withGeoNow[0].geo.lat, withGeoNow[0].geo.lng)
    } else {
      needAuth = true
    }

    if (base) {
      for (let i = 0; i < missing.length; i++) {
        const card = missing[i]
        const geo = spreadFootprints(base.lat, base.lng, i, missing.length)
        if (!geo) continue
        const placeText = (card.placeText || '').trim() || '相遇地点'
        try {
          await updateCard(card._id, { geo, placeText })
          card.geo = geo
          if (!card.placeText) card.placeText = placeText
          updated += 1
        } catch (e) {
          console.warn('[api] backfill geo fail', card._id, e)
        }
      }
    }
  }

  // 同一模糊街区叠点 → 强制散开
  const withGeo = real.filter((c) => c.geo)
  const groups = {}
  withGeo.forEach((c) => {
    const key = geoCellKey(c.geo.lat, c.geo.lng)
    if (!groups[key]) groups[key] = []
    groups[key].push(c)
  })

  const groupKeys = Object.keys(groups)
  for (let g = 0; g < groupKeys.length; g++) {
    const group = groups[groupKeys[g]]
    if (!group || group.length <= 1) continue

    let minLat = group[0].geo.lat
    let maxLat = group[0].geo.lat
    let minLng = group[0].geo.lng
    let maxLng = group[0].geo.lng
    group.forEach((c) => {
      minLat = Math.min(minLat, c.geo.lat)
      maxLat = Math.max(maxLat, c.geo.lat)
      minLng = Math.min(minLng, c.geo.lng)
      maxLng = Math.max(maxLng, c.geo.lng)
    })
    const span = Math.max(maxLat - minLat, maxLng - minLng)
    // 几乎重叠才散开；已拉开的保留真实相遇距离
    if (span >= 0.0012) continue

    const center = blurCoordinate(group[0].geo.lat, group[0].geo.lng)
    for (let i = 0; i < group.length; i++) {
      const card = group[i]
      const geo = spreadFootprints(center.lat, center.lng, i, group.length)
      if (!geo) continue
      if (
        Math.abs(geo.lat - card.geo.lat) < 1e-6 &&
        Math.abs(geo.lng - card.geo.lng) < 1e-6
      ) {
        continue
      }
      try {
        await updateCard(card._id, { geo })
        card.geo = geo
        updated += 1
      } catch (e) {
        console.warn('[api] respread geo fail', card._id, e)
      }
    }
  }

  const footprintCards = real.filter((c) => c.geo)
  return {
    updated,
    needAuth,
    cards: real,
    footprintCards,
    total: real.length,
    withGeoCount: footprintCards.length
  }
}

module.exports = {
  setCloudEnabled,
  login,
  getProfile,
  updateProfile,
  addCardToRoom,
  removeCardFromRoom,
  setRoomMain,
  recognize,
  recognizeBreedOnly,
  detectPetBox,
  listCards,
  repairOrphanCards,
  getCard,
  createCard,
  updateCard,
  requestBreedChange,
  reviewBreedChange,
  listBreedReviews,
  reattachCardImage,
  releaseCard,
  listMyReleased,
  adoptVisitor,
  backfillMissingCardGeo,
  listMemories,
  createMemory,
  canEmbedCatPhoto,
  embedCatPhoto,
  deleteMemory,
  reportDuelResult,
  breedFilters,
  filtersFromCards,
  getRoomState,
  careCat,
  saveRoomFurniture,
  interactVisitor,
  dismissReport,
  dismissLeftTrace,
  listOutingLogs,
  listVisitLogs,
  debugAdvanceOuting
}
