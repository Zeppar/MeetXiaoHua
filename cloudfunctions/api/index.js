/**
 * 统一云函数：action 路由
 * 集合：users / cards / memories / duels（duels 仅预留）
 */
const cloud = require('wx-server-sdk')
const { normalizePhotoIdentity, appendIdentity } = require('./photo-identity')

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })
const db = cloud.database()
const _ = db.command

const WHITELIST = [
  '中华田园猫', '橘猫', '狸花猫', '英国短毛猫', '美国短毛猫', '布偶猫', '暹罗猫', '加菲猫',
  '中华田园犬', '金毛', '泰迪', '柯基', '哈士奇', '拉布拉多',
  '麻雀', '鸽子', '喜鹊', '兔子', '松鼠', '鸭子', '鹅'
]
const UNKNOWN_LABEL = '未知小动物'
const CONFIDENCE_THRESHOLD = 70

function clampText(text, max) {
  const s = String(text || '').trim()
  return s.length <= max ? s : s.slice(0, max)
}

function normalizeGeo(geo) {
  if (!geo || typeof geo !== 'object') return null
  const lat = Number(geo.lat != null ? geo.lat : geo.latitude)
  const lng = Number(geo.lng != null ? geo.lng : geo.longitude)
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
  if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null
  return { lat, lng }
}

function defaultSettings() {
  return { allowMyCatOut: true, allowVisitors: true, showDistance: true }
}

function defaultOuting() {
  return {
    status: 'idle',
    cardId: '',
    homeSince: 0,
    homeDuration: 0,
    leftAt: 0,
    travelDuration: 0,
    visitArriveAt: 0,
    visitDuration: 0,
    visitId: '',
    hostKey: '',
    distanceKm: 0,
    behaviorIndex: -1,
    behaviorText: '',
    lastBehaviorIndex: -1,
    pet: false,
    fed: false,
    unreadReport: null,
    lastAutoReportDay: ''
  }
}

const BEHAVIORS = [
  '它在你门口打了个滚。',
  '它盯着你的猫看了很久。',
  '它在你家窗台上睡了一觉。',
  '它绕着你的猫窝转了三圈。',
  '它在你家门口坐了一会儿，好像在等谁。',
  '它把你的猫粮碗闻了闻，又走开了。',
  '它在你家地板上踩了几个梅花印。',
  '它对着你的猫眨了眨眼。'
]

const HOUR_MS = 60 * 60 * 1000

function randBetweenHours(minH, maxH) {
  const min = minH * HOUR_MS
  const max = maxH * HOUR_MS
  return Math.floor(min + Math.random() * (max - min + 1))
}

function formatDistanceLabel(km, showDistance) {
  if (!showDistance) return '远方的小屋'
  return `${(Number(km) || 0.1).toFixed(1)} 千米外的小屋`
}

function pickBehavior(lastIndex) {
  let index = Math.floor(Math.random() * BEHAVIORS.length)
  if (index === lastIndex) index = (index + 1) % BEHAVIORS.length
  return { index, text: BEHAVIORS[index] }
}

function isAway(outing) {
  return outing && (outing.status === 'out' || outing.status === 'visiting')
}

function normalizeUser(user) {
  user.settings = { ...defaultSettings(), ...user.settings }
  if (!user.outing) user.outing = defaultOuting()
  if (!user.fedDate) user.fedDate = ''
  return user
}

async function ensureUser(openid) {
  const col = db.collection('users')
  const found = await col.where({ _openid: openid }).limit(1).get()
  if (found.data && found.data.length) {
    const user = found.data[0]
    const defaults = defaultSettings()
    const missing = {}
    if (!user.settings || typeof user.settings !== 'object') {
      missing.settings = defaults
    } else {
      for (const key of Object.keys(defaults)) {
        if (!Object.prototype.hasOwnProperty.call(user.settings, key)) {
          missing['settings.' + key] = defaults[key]
        }
      }
    }
    if (Object.keys(missing).length) await col.doc(user._id).update({ data: missing })
    return normalizeUser(user)
  }
  // 云函数写入不会自动带用户 openid，必须显式写入
  const doc = {
    _openid: openid,
    nickName: '猫友',
    avatarUrl: '',
    displayCardId: '',
    roomMateIds: [],
    roomBackgroundId: 'default',
    stats: { cardCount: 0, breedCount: 0, memoryCount: 0 },
    privacyAgreedAt: 0,
    settings: defaultSettings(),
    outing: defaultOuting(),
    fedDate: '',
    createdAt: Date.now()
  }
  const addRes = await col.add({ data: doc })
  return { _id: addRes._id, _openid: openid, ...doc }
}

async function recomputeStats(openid) {
  const cards = await queryOwnedCards(openid)
  let memTotal = 0
  try {
    const memRes = await db
      .collection('memories')
      .where(_.or([{ _openid: openid }, { ownerOpenId: openid }]))
      .count()
    memTotal = memRes.total || 0
  } catch (e) {
    const memRes = await db.collection('memories').where({ _openid: openid }).count()
    memTotal = memRes.total || 0
  }
  const breeds = new Set(cards.map((c) => c.breed))
  const stats = {
    cardCount: cards.length,
    breedCount: breeds.size,
    memoryCount: memTotal
  }
  const users = await db.collection('users').where({ _openid: openid }).limit(1).get()
  if (users.data && users.data[0]) {
    await db.collection('users').doc(users.data[0]._id).update({ data: { stats } })
  }
  return stats
}

async function login(openid) {
  const user = await ensureUser(openid)
  const stats = await recomputeStats(openid)
  return { openid, user: { ...user, stats } }
}

async function getProfile(openid) {
  const user = await ensureUser(openid)
  const stats = await recomputeStats(openid)
  return { user: { ...user, stats } }
}

async function updateProfile(openid, payload = {}) {
  const user = await ensureUser(openid)
  const data = {}
  ;['nickName', 'avatarUrl', 'displayCardId', 'roomBackgroundId', 'privacyAgreedAt', 'fuzzyGeo'].forEach((k) => {
    if (payload[k] !== undefined) data[k] = payload[k]
  })
  if (payload.roomMateIds !== undefined) {
    const main = payload.displayCardId !== undefined ? payload.displayCardId : user.displayCardId
    const list = Array.isArray(payload.roomMateIds) ? payload.roomMateIds : []
    const seen = {}
    data.roomMateIds = list
      .map((id) => String(id || ''))
      .filter((id) => {
        if (!id || id === main || seen[id]) return false
        seen[id] = true
        return true
      })
      .slice(0, 2)
  }
  if (payload.settings) {
    for (const key of Object.keys(defaultSettings())) {
      if (typeof payload.settings[key] === 'boolean') data['settings.' + key] = payload.settings[key]
    }
  }
  if (Object.keys(data).length) {
    await db.collection('users').doc(user._id).update({ data })
  }
  return getProfile(openid)
}

async function recognize(event = {}) {
  // 腾讯云 DetectPet + DetectLabel；抠图白边仍在小程序端完成
  const started = Date.now()
  console.log('[api.recognize timing] enter')
  const { recognizePet } = require('./pet-recognize')
  let imageBase64 = event.imageBase64 || ''
  const imageUrl = event.imageUrl || ''
  const fileID = event.fileID || ''
  const imageWidth = event.imageWidth || 0
  const imageHeight = event.imageHeight || 0

  if (!imageBase64 && fileID) {
    const dlStart = Date.now()
    const dl = await cloud.downloadFile({ fileID })
    const buf = dl.fileContent
    imageBase64 = Buffer.from(buf).toString('base64')
    console.log('[api.recognize timing] downloadFile:', `${Date.now() - dlStart}ms`)
  }

  const result = await recognizePet({ imageBase64, imageUrl, imageWidth, imageHeight })
  console.log('[api.recognize timing] total:', `${Date.now() - started}ms`, {
    ok: result && result.ok,
    code: result && result.code,
    breed: result && result.breed
  })
  return result
}

async function runMatting(event = {}, openid = '') {
  const started = Date.now()
  console.log('[api.matting timing] enter')
  const { matting } = require('./matting')
  let imageBase64 = event.imageBase64 || ''
  const imageUrl = event.imageUrl || ''
  const fileID = event.fileID || ''

  if (!imageBase64 && fileID) {
    const dlStart = Date.now()
    const dl = await cloud.downloadFile({ fileID })
    imageBase64 = Buffer.from(dl.fileContent).toString('base64')
    console.log('[api.matting timing] downloadFile:', `${Date.now() - dlStart}ms`)
  }

  const result = await matting({
    imageBase64,
    imageUrl,
    provider: event.provider || ''
  })
  if (!result || !result.ok || !result.imageBase64) {
    console.log('[api.matting timing] total:', `${Date.now() - started}ms`, {
      ok: result && result.ok,
      code: result && result.code,
      provider: result && result.provider
    })
    return result
  }

  // 云函数返回体上限约 1MB，透明 PNG base64 很容易超限 → 改传云存储 fileID
  const upStart = Date.now()
  const buf = Buffer.from(String(result.imageBase64).replace(/^data:image\/\w+;base64,/, ''), 'base64')
  const safeOpenId = String(openid || 'anon').replace(/[^\w-]/g, '').slice(0, 48) || 'anon'
  const cloudPath = `matting/${safeOpenId}/${Date.now()}.png`
  const uploaded = await cloud.uploadFile({
    cloudPath,
    fileContent: buf
  })
  console.log('[api.matting timing] uploadFile:', `${Date.now() - upStart}ms`, {
    bytes: buf.length,
    fileID: uploaded.fileID
  })

  const out = {
    ok: true,
    provider: result.provider,
    mime: result.mime || 'image/png',
    fileID: uploaded.fileID,
    bordered: !!result.bordered,
    timing: [...(result.timing || []), `上传云存储: ${Date.now() - upStart}ms`]
  }
  console.log('[api.matting timing] total:', `${Date.now() - started}ms`, {
    ok: true,
    provider: out.provider,
    fileID: out.fileID
  })
  return out
}

async function embedCatPhoto(openid, imageBase64) {
  const { rembg } = require('./recognize-config').getRecognizeConfig()
  if (!openid || !rembg.url || !rembg.reidEnabled) return { code: 'DISABLED' }
  if (typeof imageBase64 !== 'string' || !imageBase64 || imageBase64.length > 350000 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) return { code: 'BAD_IMAGE' }
  const url = new URL(rembg.url.trim())
  const path = url.pathname.split('/').filter(Boolean)
  if (path[path.length - 1] === 'remove' && path[path.length - 2] === 'api') path.splice(-2)
  url.pathname = '/' + [...path, 'api', 'embed'].join('/')
  url.search = ''
  const { request } = require('./http-util')
  try {
    const result = await request(url.toString(), {
      method: 'POST',
      body: Buffer.from(imageBase64, 'base64'),
      headers: {
        'Content-Type': 'image/jpeg',
        ...(rembg.token ? { 'X-Rembg-Token': rembg.token } : {})
      },
      timeoutMs: 3200
    })
    if (result.statusCode === 404 || result.statusCode === 503) return { code: 'DISABLED' }
    const identity = normalizePhotoIdentity(result.json)
    return { embedding: identity ? identity.embedding : '' }
  } catch (e) {
    return { code: 'UNAVAILABLE' }
  }
}

function cardBelongsTo(card, openid) {
  if (!card || !openid) return false
  if (card._openid === openid) return true
  if (card.ownerOpenId === openid) return true
  return false
}

/**
 * 认领历史孤儿卡：云函数早期建卡未写 _openid，导致 listCards 永远空。
 * _openid 创建后通常不可改，故复制为新文档再删旧文档。
 */
async function repairOrphanCards(openid) {
  if (!openid) return { repaired: [], count: 0, scanned: 0 }
  let scanned = 0
  const repaired = []
  try {
    const res = await db.collection('cards').orderBy('createdAt', 'desc').limit(100).get()
    const all = res.data || []
    scanned = all.length
    // 只认领真正无归属的历史卡；有 _openid / ownerOpenId 的卡一律不动（防止抢别人的卡）
    for (const card of all) {
      if (cardBelongsTo(card, openid)) continue
      const orphan = !card._openid && !card.ownerOpenId
      if (!orphan) continue
      const oldId = card._id
      const { _id, ...rest } = card
      const doc = {
        ...rest,
        _openid: openid,
        ownerOpenId: openid,
        repairedFrom: oldId,
        repairedAt: Date.now()
      }
      const addRes = await db.collection('cards').add({ data: doc })
      try {
        await db.collection('cards').doc(oldId).remove()
      } catch (e) {
        console.warn('repair remove old card fail', oldId, e)
      }
      repaired.push({ oldId, newId: addRes._id, breed: card.breed || '' })
    }
  } catch (e) {
    console.warn('repairOrphanCards fail', e)
  }
  if (repaired.length) {
    try {
      await recomputeStats(openid)
    } catch (e) {
      /* ignore */
    }
  }
  return { repaired, count: repaired.length, scanned }
}

async function queryOwnedCards(openid, { limit = Infinity, breed } = {}) {
  const condition = breed && breed !== '全部' ? { breed } : {}
  const cards = new Map()
  const pageSize = 100
  for (const field of ['_openid', 'ownerOpenId']) {
    const query = db.collection('cards').where({ ...condition, [field]: openid })
      .orderBy('shotAt', 'desc')
    for (let offset = 0; offset < limit; offset += pageSize) {
      const size = Math.min(pageSize, limit - offset)
      const { data = [] } = await query.skip(offset).limit(size).get()
      data.forEach((card) => cards.set(card._id, card))
      if (data.length < size) break
    }
  }
  return Array.from(cards.values()).sort((a, b) =>
    (b.shotAt || 0) - (a.shotAt || 0) || a._id.localeCompare(b._id)
  ).slice(0, limit)
}

async function listCards(openid, { limit = 100, breed } = {}) {
  const size = Math.min(100, Math.max(1, Math.floor(Number(limit) || 100)))
  return { cards: await queryOwnedCards(openid, { limit: size, breed }) }
}

async function getCard(openid, cardId) {
  if (!cardId) return { card: null }
  try {
    const res = await db.collection('cards').doc(cardId).get()
    const card = res.data
    if (!card) return { card: null }
    if (!cardBelongsTo(card, openid) && (card._openid || card.ownerOpenId)) {
      return { card: null }
    }
    // 无归属的历史卡：允许当前用户读取并顺带打上 ownerOpenId（_openid 可能改不了）
    if (!cardBelongsTo(card, openid)) {
      try {
        await db.collection('cards').doc(cardId).update({ data: { ownerOpenId: openid } })
        card.ownerOpenId = openid
      } catch (e) {
        /* ignore */
      }
    }
    return { card }
  } catch (e) {
    // 文档不存在时不抛到顶层，方便客户端回退本地镜像
    return { card: null }
  }
}

function normalizeRecognizedBreedCloud(breed) {
  const b = String(breed || '').trim()
  if (!b || b === '待识别' || b === '识别中…' || b === UNKNOWN_LABEL) return ''
  return b
}

async function createCard(openid, payload = {}) {
  await ensureUser(openid)
  const geo = normalizeGeo(payload.geo)
  if (!geo) {
    return { error: '需要位置信息才能记录相遇', code: 'GEO_REQUIRED' }
  }
  const doc = buildCard(openid, payload, geo)
  if (doc.clientId) {
    try {
      const dup = await db.collection('cards').where({ _openid: openid, clientId: doc.clientId }).limit(1).get()
      if (dup.data && dup.data[0]) return { card: dup.data[0], deduped: true }
    } catch (e) {
      /* ignore */
    }
  }
  const addRes = await db.collection('cards').add({ data: doc })
  if (doc.pendingBreed) {
    const rev = await db.collection('breed_reviews').add({
      data: {
        _openid: openid,
        cardId: addRes._id,
        fromBreed: doc.breed,
        toBreed: doc.pendingBreed,
        recognizedBreed: doc.recognizedBreed,
        status: 'pending',
        createdAt: Date.now()
      }
    })
    await db.collection('cards').doc(addRes._id).update({ data: { breedReviewId: rev._id } })
    doc.breedReviewId = rev._id
  }
  await recomputeStats(openid)
  return { card: { _id: addRes._id, ...doc } }
}

function buildCard(openid, payload, geo) {
  const recognizedBreed = normalizeRecognizedBreedCloud(
    payload.recognizedBreed !== undefined ? payload.recognizedBreed : payload.breed
  )
  let breed = clampText(payload.breed || '', 20) || UNKNOWN_LABEL
  let pendingBreed = ''
  let breedReviewStatus = ''
  if (payload.breedManual && breed && (!recognizedBreed || breed !== recognizedBreed)) {
    pendingBreed = breed
    breedReviewStatus = 'pending'
    breed = recognizedBreed || '待识别'
  }
  return {
    _openid: openid,
    ownerOpenId: openid,
    clientId: clampText(payload.clientId || '', 64),
    cutoutFileId: payload.cutoutFileId || '',
    originalFileId: payload.originalFileId || '',
    cutoutPath: payload.cutoutPath || '',
    originalPath: payload.originalPath || '',
    photoIdentities: appendIdentity([], normalizePhotoIdentity(payload.photoIdentity)),
    breed,
    recognizedBreed,
    pendingBreed,
    breedReviewStatus,
    breedReviewId: '',
    name: clampText(payload.name || '', 12),
    confidence: payload.confidence || 0,
    shotAt: payload.shotAt || Date.now(),
    note: clampText(payload.note, 100),
    placeText: clampText(payload.placeText, 30),
    geo,
    mattingFailed: !!payload.mattingFailed,
    memoryCount: 0,
    intimacy: Math.max(0, Math.min(100, Math.round(Number(payload.intimacy != null ? payload.intimacy : 8) || 0))),
    intimacyDay: '',
    intimacyGainedToday: 0,
    recordStats: { duelWins: 0, duelLosses: 0, lastDuelAt: 0 },
    createdAt: Date.now()
  }
}

async function updateCard(openid, cardId, patch = {}) {
  // getCard 已做归属校验（别人的卡返回 null），不能再绕过去读原始文档
  const { card } = await getCard(openid, cardId)
  if (!card || !cardBelongsTo(card, openid)) return { error: 'card not found', code: 'NOT_FOUND' }
  const data = {}
  if (!card.ownerOpenId) data.ownerOpenId = openid
  if (patch.name !== undefined) data.name = clampText(patch.name, 12)
  // 品种仅允许审核通过后写入
  if (patch.breed !== undefined && patch._breedReviewApply) {
    data.breed = clampText(patch.breed, 20) || UNKNOWN_LABEL
    if (patch.confidence !== undefined) data.confidence = Number(patch.confidence) || 0
    else if (data.breed && data.breed !== UNKNOWN_LABEL) data.confidence = 100
  }
  if (patch.confidence !== undefined && patch.breed === undefined) {
    data.confidence = Number(patch.confidence) || 0
  }
  if (patch.note !== undefined) data.note = clampText(patch.note, 100)
  if (patch.placeText !== undefined) data.placeText = clampText(patch.placeText, 30)
  if (patch.geo !== undefined) {
    const geo = normalizeGeo(patch.geo)
    if (patch.geo !== null && !geo) return { error: 'invalid geo', code: 'BAD_REQUEST' }
    data.geo = _.set(geo)
  }
  if (patch.intimacy !== undefined) {
    data.intimacy = Math.max(0, Math.min(100, Math.round(Number(patch.intimacy) || 0)))
  }
  if (patch.intimacyDay !== undefined) data.intimacyDay = String(patch.intimacyDay || '')
  if (patch.intimacyGainedToday !== undefined) {
    data.intimacyGainedToday = Math.max(0, Number(patch.intimacyGainedToday) || 0)
  }
  if (patch.memoryCount !== undefined) data.memoryCount = patch.memoryCount
  if (patch.cutoutPath !== undefined) data.cutoutPath = patch.cutoutPath || ''
  if (patch.originalPath !== undefined) data.originalPath = patch.originalPath || ''
  if (patch.cutoutFileId !== undefined) data.cutoutFileId = patch.cutoutFileId || ''
  if (patch.originalFileId !== undefined) data.originalFileId = patch.originalFileId || ''
  if (patch.mattingFailed !== undefined) data.mattingFailed = !!patch.mattingFailed
  if (patch.pendingBreed !== undefined) data.pendingBreed = patch.pendingBreed || ''
  if (patch.breedReviewStatus !== undefined) data.breedReviewStatus = patch.breedReviewStatus || ''
  if (patch.breedReviewId !== undefined) data.breedReviewId = patch.breedReviewId || ''
  if (patch.recognizedBreed !== undefined) {
    data.recognizedBreed = normalizeRecognizedBreedCloud(patch.recognizedBreed)
  }
  if (Object.keys(data).length) {
    await db.collection('cards').doc(cardId).update({ data })
  }
  return getCard(openid, cardId)
}

async function requestBreedChange(openid, { cardId, breed }) {
  const target = clampText(breed || '', 20)
  if (!target) return { error: '请选择品种', code: 'BAD_REQUEST' }
  const { card } = await getCard(openid, cardId)
  if (!card) return { error: 'card not found', code: 'NOT_FOUND' }
  let recognizedBreed = normalizeRecognizedBreedCloud(card.recognizedBreed)
  if (card.recognizedBreed === undefined) {
    recognizedBreed = normalizeRecognizedBreedCloud(card.breed)
    await db.collection('cards').doc(cardId).update({ data: { recognizedBreed } })
  }
  if (card.breedReviewStatus === 'pending') {
    return { error: '审核中，暂时不能换品种', code: 'PENDING' }
  }
  if (card.breed === target) {
    return { card, mode: 'noop', toast: '已经是这个品种了' }
  }
  const rev = await db.collection('breed_reviews').add({
    data: {
      _openid: openid,
      cardId,
      fromBreed: card.breed || '',
      toBreed: target,
      recognizedBreed,
      status: 'pending',
      createdAt: Date.now()
    }
  })
  await db.collection('cards').doc(cardId).update({
    data: {
      pendingBreed: target,
      breedReviewStatus: 'pending',
      breedReviewId: rev._id,
      recognizedBreed
    }
  })
  const again = await getCard(openid, cardId)
  return {
    card: again.card,
    mode: 'pending',
    toast: '已提交审核，通过后才会更换品种'
  }
}

/**
 * 审核员名单：环境变量 / secrets.local.js 里的 ADMIN_OPENIDS（逗号分隔）
 * 未配置时为开发模式：只允许卡主审核自己的卡（上线前务必配置）
 */
function getAdminOpenIds() {
  const local = require('./recognize-config').loadLocalSecrets()
  const raw = process.env.ADMIN_OPENIDS || local.ADMIN_OPENIDS || ''
  const list = Array.isArray(raw) ? raw : String(raw).split(',')
  return list.map((s) => String(s).trim()).filter(Boolean)
}

async function loadCardForReview(openid, cardId) {
  if (!cardId) return null
  const admins = getAdminOpenIds()
  if (admins.length) {
    if (admins.indexOf(openid) < 0) return null
    try {
      const raw = await db.collection('cards').doc(cardId).get()
      return raw.data || null
    } catch (e) {
      return null
    }
  }
  const { card } = await getCard(openid, cardId)
  return card && cardBelongsTo(card, openid) ? card : null
}

async function reviewBreedChange(openid, event = {}) {
  // 不信任客户端传来的 approveBreed：目标品种只取审核单 / 卡上的 pendingBreed
  const { reviewId, approve } = event
  let { cardId } = event
  const admins = getAdminOpenIds()
  if (admins.length && admins.indexOf(openid) < 0) {
    return { error: '没有审核权限', code: 'FORBIDDEN' }
  }
  if (!admins.length) console.warn('[reviewBreedChange] ADMIN_OPENIDS 未配置，按开发模式仅允许卡主审核')
  let review = null
  if (reviewId) {
    try {
      const r = await db.collection('breed_reviews').doc(reviewId).get()
      review = r.data
      if (review) review._id = reviewId
    } catch (e) {
      /* ignore */
    }
  }
  if (!review && cardId) {
    try {
      const res = await db
        .collection('breed_reviews')
        .where({ cardId, status: 'pending' })
        .limit(1)
        .get()
      review = (res.data && res.data[0]) || null
    } catch (e) {
      /* ignore */
    }
  }

  // 审核表缺失时，只按卡上的 pendingBreed 落品种
  if (!review || review.status !== 'pending') {
    if (!cardId) return { error: '没有待审申请', code: 'GONE' }
    const card = await loadCardForReview(openid, cardId)
    if (!card) return { error: 'card not found', code: 'NOT_FOUND' }
    if (card.breedReviewStatus !== 'pending') return { error: '没有待审申请', code: 'GONE' }
    const toBreed = clampText(card.pendingBreed || '', 20)
    if (approve) {
      if (!toBreed) return { error: '缺少目标品种，无法通过', code: 'BAD_REQUEST' }
      await db.collection('cards').doc(cardId).update({
        data: {
          breed: toBreed,
          confidence: 100,
          pendingBreed: '',
          breedReviewStatus: 'approved',
          breedReviewId: ''
        }
      })
      return { card: await loadCardForReview(openid, cardId), toast: '审核已通过，品种已更新' }
    }
    await db.collection('cards').doc(cardId).update({
      data: { pendingBreed: '', breedReviewStatus: 'rejected', breedReviewId: '' }
    })
    return { card: await loadCardForReview(openid, cardId), toast: '审核未通过，仍保持原品种' }
  }

  const cid = review.cardId
  // 审核单对应的卡必须是自己的（开发模式）或调用者是审核员
  if (!(await loadCardForReview(openid, cid))) return { error: 'card not found', code: 'NOT_FOUND' }
  if (!admins.length && review._openid && review._openid !== openid) {
    return { error: '没有审核权限', code: 'FORBIDDEN' }
  }
  const toBreed = clampText(review.toBreed || '', 20)
  if (approve) {
    if (!toBreed) return { error: '缺少目标品种，无法通过', code: 'BAD_REQUEST' }
    try {
      await db.collection('breed_reviews').doc(review._id).update({
        data: { status: 'approved', reviewedAt: Date.now(), reviewedBy: openid, toBreed }
      })
    } catch (e) {
      /* ignore */
    }
    await db.collection('cards').doc(cid).update({
      data: {
        breed: toBreed,
        confidence: 100,
        pendingBreed: '',
        breedReviewStatus: 'approved',
        breedReviewId: ''
      }
    })
    return { card: await loadCardForReview(openid, cid), toast: '审核已通过，品种已更新' }
  }
  try {
    await db.collection('breed_reviews').doc(review._id).update({
      data: { status: 'rejected', reviewedAt: Date.now(), reviewedBy: openid }
    })
  } catch (e) {
    /* ignore */
  }
  await db.collection('cards').doc(cid).update({
    data: { pendingBreed: '', breedReviewStatus: 'rejected', breedReviewId: '' }
  })
  return { card: await loadCardForReview(openid, cid), toast: '审核未通过，仍保持原品种' }
}

async function listBreedReviews(openid, { status } = {}) {
  const where = { _openid: openid }
  if (status) where.status = status
  let list = []
  try {
    const res = await db
      .collection('breed_reviews')
      .where(where)
      .orderBy('createdAt', 'desc')
      .limit(50)
      .get()
    list = res.data || []
  } catch (e) {
    try {
      // 无索引 / 集合刚建时降级
      const res = await db.collection('breed_reviews').where({ _openid: openid }).limit(50).get()
      list = res.data || []
      if (status) list = list.filter((r) => r && r.status === status)
      list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
    } catch (e2) {
      console.warn('listBreedReviews fail', e2)
      list = []
    }
  }

  // 再从图鉴 pending 卡补一轮，避免只有卡字段、审核表漏写
  try {
    const cardsRes = await listCards(openid, { limit: 100 })
    const pendingCards = (cardsRes.cards || []).filter(
      (c) => c && (c.breedReviewStatus === 'pending' || c.pendingBreed)
    )
    const have = {}
    list.forEach((r) => {
      if (r && r.cardId) have[r.cardId] = true
    })
    pendingCards.forEach((c) => {
      if (have[c._id]) return
      if (status && status !== 'pending') return
      list.push({
        _id: c.breedReviewId || `card_${c._id}`,
        _openid: openid,
        cardId: c._id,
        fromBreed: c.breed || '',
        toBreed: c.pendingBreed || '',
        recognizedBreed: c.recognizedBreed || '',
        status: 'pending',
        createdAt: c.createdAt || Date.now()
      })
    })
  } catch (e) {
    /* ignore */
  }

  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return { list }
}

async function listMemories(openid, cardId) {
  const res = await db
    .collection('memories')
    .where({ _openid: openid, cardId })
    .orderBy('createdAt', 'asc')
    .get()
  return { memories: res.data || [] }
}

async function createMemory(openid, payload = {}) {
  const { card } = await getCard(openid, payload.cardId)
  if (!card) return { error: 'card not found', code: 'NOT_FOUND' }
  const identity = normalizePhotoIdentity(payload.photoIdentity)
  const doc = {
    _openid: openid,
    ownerOpenId: openid,
    cardId: payload.cardId,
    text: clampText(payload.text, 200),
    imageFileId: payload.imageFileId || '',
    imagePath: payload.imagePath || '',
    createdAt: Date.now()
  }
  const memory = await db.runTransaction(async (tx) => {
    const ref = tx.collection('cards').doc(payload.cardId)
    const current = await readDocument(ref)
    if (!cardBelongsTo(current, openid)) return null
    const result = await tx.collection('memories').add({ data: doc })
    const data = { memoryCount: _.inc(1) }
    if (identity) data.photoIdentities = appendIdentity(current.photoIdentities, identity)
    await ref.update({ data })
    return { _id: result._id, ...doc }
  })
  if (!memory) return { error: 'card not found', code: 'NOT_FOUND' }
  await recomputeStats(openid).catch((e) => console.warn('create memory stats fail', e))
  return { memory }
}

async function deleteMemory(openid, memoryId) {
  const res = await db.collection('memories').doc(memoryId).get()
  const memory = res.data
  if (!memory || memory._openid !== openid) return { error: 'not found', code: 'NOT_FOUND' }
  await db.collection('memories').doc(memoryId).remove()
  const countRes = await db.collection('memories').where({ cardId: memory.cardId }).count()
  await db.collection('cards').doc(memory.cardId).update({ data: { memoryCount: countRes.total } })
  await recomputeStats(openid)
  return { ok: true, cardId: memory.cardId }
}

async function breedFilters(openid) {
  const cards = await queryOwnedCards(openid)
  const counts = Object.create(null)
  cards.forEach((c) => {
    counts[c.breed] = (counts[c.breed] || 0) + 1
  })
  const filters = Object.keys(counts)
    .map((breed) => ({ breed, count: counts[breed] }))
    .sort((a, b) => b.count - a.count)
  return { filters }
}

/** 预留：异步切磋胜负回写 */
async function reportDuelResult(openid, payload = {}) {
  const { card } = await getCard(openid, payload.myCardId)
  if (!card) return { error: 'card not found', code: 'NOT_FOUND' }
  const stats = card.recordStats || { duelWins: 0, duelLosses: 0, lastDuelAt: 0 }
  if (payload.outcome === 'win') stats.duelWins += 1
  else if (payload.outcome === 'lose') stats.duelLosses += 1
  stats.lastDuelAt = Date.now()
  await db.collection('cards').doc(payload.myCardId).update({ data: { recordStats: stats } })
  await db.collection('duels').add({
    data: {
      myCardId: payload.myCardId,
      peerCardId: payload.peerCardId || '',
      outcome: payload.outcome,
      createdAt: Date.now()
    }
  })
  return getCard(openid, payload.myCardId)
}

function todayKey(now = Date.now()) {
  const d = new Date(now)
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`
}

// 明信片只带猫的立绘，和串门访客展示的信息范围一致。
async function pickOutingFriend(tx, host) {
  if (!host.displayCardId) return null
  if (isAway(host.outing) && host.outing.cardId === host.displayCardId) return null
  const resident = await readDocument(tx.collection('cards').doc(host.displayCardId))
  if (!cardBelongsTo(resident, host._openid)) return null
  const image = [resident.cutoutFileId, resident.cutoutPath].find((path) => /^cloud:\/\//.test(path || ''))
  return image ? { image, kind: 'photo' } : null
}

function buildReport(outing, card, showDistance, log) {
  const distLabel = formatDistanceLabel(outing.distanceKm, showDistance)
  const breed = card.breed
  let interactLine = '它在那里待了一会儿。'
  if (outing.pet) interactLine = '有人摸了摸它。'
  if (outing.fed) interactLine = outing.pet ? '有人摸了摸它。有人给了它一颗猫粮。' : '有人给了它一颗猫粮。'
  return {
    title: '🐾 它回来了',
    distanceLine: `${card.name || '你的' + ((['待识别', '识别中…', '未知小动物'].indexOf(breed) >= 0 ? '' : breed) || '小猫')}去了一趟「${distLabel}」`,
    behaviorLine: outing.behaviorText || '',
    interactLine,
    catImage: log.catImage,
    behaviorIndex: log.behaviorIndex,
    friend: log.friend,
    pet: log.pet,
    fed: log.fed,
    simulated: log.simulated,
    createdAt: log.returnedAt
  }
}

async function releaseCard(openid, cardId) {
  const { card } = await getCard(openid, cardId)
  if (!card) {
    const { data } = await db.collection('released_cats').where({ releasedBy: openid, cardId }).limit(1).get()
    return data && data[0]
      ? { ok: true, released: data[0], toast: '它自由了。以后也许会去别人家串门。' }
      : { error: 'card not found', code: 'NOT_FOUND' }
  }

  const user = await ensureUser(openid)
  const { cards: remaining } = await listCards(openid, { limit: 2 })
  // 兼容旧版在切换展示猫时丢失行程引用，但访问还未结束的记录。
  const now = Date.now()
  const active = await db.collection('visits').where({
    ownerOpenId: openid, guestCardId: cardId, status: 'active', leaveAt: _.gt(now)
  }).limit(100).get()
  if (active.data.some((v) => !v.fromReleased)) {
    return { error: '这只猫还在外面，回来后才能放生', code: 'CAT_AWAY' }
  }

  const result = await db.runTransaction(async (tx) => {
    const userRef = tx.collection('users').doc(user._id)
    const cardRef = tx.collection('cards').doc(cardId)
    const current = normalizeUser((await userRef.get()).data)
    const cat = await readDocument(cardRef)
    if (!cardBelongsTo(cat, openid)) return { error: 'card not found', code: 'NOT_FOUND' }
    if (isAway(current.outing) && current.outing.cardId === cardId) {
      return { error: '这只猫还在外面，回来后才能放生', code: 'CAT_AWAY' }
    }
    if (cat.breedReviewStatus === 'pending' || cat.pendingBreed) {
      return { error: '审核中不能放生', code: 'PENDING' }
    }

    const roomMateIds = Array.isArray(current.roomMateIds)
      ? current.roomMateIds.filter((id) => id && id !== cardId)
      : []
    let displayCardId = current.displayCardId || ''
    if (displayCardId === cardId) {
      const next = remaining.find((item) => item._id !== cardId)
      displayCardId = roomMateIds.shift() || (next && next._id) || ''
    }
    const room = { displayCardId, roomMateIds }
    if (!isAway(current.outing) && current.outing.cardId === cardId) {
      room.outing = Object.assign({}, current.outing, {
        status: displayCardId ? 'home' : 'idle',
        cardId: displayCardId,
        homeSince: displayCardId ? now : 0,
        homeDuration: displayCardId ? randBetweenHours(6, 12) : 0
      })
    }

    const released = {
      _openid: openid,
      ownerOpenId: openid,
      cardId,
      breed: cat.breed || '待识别',
      name: cat.name || '',
      cutoutPath: cat.cutoutPath || '',
      originalPath: cat.originalPath || '',
      cutoutFileId: cat.cutoutFileId || '',
      originalFileId: cat.originalFileId || '',
      releasedBy: openid,
      releasedAt: now,
      visitCount: 0,
      lastVisitAt: 0,
      status: 'wandering',
      adoptedBy: '',
      adoptedAt: 0,
      adoptedCardId: ''
    }
    const added = await tx.collection('released_cats').add({ data: released })
    await cardRef.remove()
    await userRef.update({ data: room })
    return { ok: true, room, released: { _id: added._id, ...released }, toast: '它自由了。以后也许会去别人家串门。' }
  })
  if (result.ok) await recomputeStats(openid).catch((e) => console.warn('release stats fail', e))
  return result
}

/** 把放生池里的猫随机送到当前小屋串门 */
async function maybeSpawnReleasedVisitor(openid, now) {
  const user = await ensureUser(openid)
  if (!(user.settings || defaultSettings()).allowVisitors) return null
  const active = await db.collection('visits').where({ hostOpenId: openid, status: 'active' }).count()
  if ((active.total || 0) > 0) return null

  const last = user._lastReleasedVisitorAt || 0
  if (now - last < 2 * 60 * 60 * 1000) return null
  if (Math.random() > 0.35) return null

  let pool = []
  try {
    const res = await db
      .collection('released_cats')
      .where({ status: 'wandering' })
      .orderBy('releasedAt', 'desc')
      .limit(40)
      .get()
    pool = res.data || []
  } catch (e) {
    try {
      const res = await db.collection('released_cats').limit(40).get()
      pool = (res.data || []).filter((r) => r.status === 'wandering')
    } catch (e2) {
      return null
    }
  }
  if (!pool.length) return null

  const others = pool.filter((r) => r.releasedBy !== openid)
  const pick = (others.length ? others : pool)[Math.floor(Math.random() * (others.length ? others.length : pool.length))]
  if (!pick) return null

  const behaviorText =
    pick.releasedBy === openid
      ? '它在门口停了一会儿，好像认出了这里。'
      : pick.name
        ? `流浪的「${pick.name}」来串门了。`
        : '一只被放生的小猫路过你家，停了下来。'

  return db.runTransaction(async (tx) => {
    const userRef = tx.collection('users').doc(user._id)
    const releasedRef = tx.collection('released_cats').doc(pick._id)
    const current = normalizeUser((await userRef.get()).data)
    const released = await readDocument(releasedRef)
    if (!current.settings.allowVisitors || now - (current._lastReleasedVisitorAt || 0) < 2 * HOUR_MS) return null
    if (!released || released.status !== 'wandering') return null

    const added = await tx.collection('visits').add({
      data: {
        hostOpenId: openid,
        ownerOpenId: released.releasedBy || 'released',
        guestCardId: released.cardId || '',
        releasedId: released._id,
        breed: released.breed || '待识别',
        name: released.name || '',
        cutoutPath: released.cutoutFileId || released.cutoutPath || '',
        behaviorText,
        distanceKm: Math.round((0.5 + Math.random() * 7.5) * 10) / 10,
        arriveAt: now,
        leaveAt: now + randBetweenHours(1, 4),
        status: 'active',
        petByHost: false,
        fedByHost: false,
        seenLeft: false,
        fromReleased: true,
        canAdopt: true
      }
    })
    await releasedRef.update({
      data: { status: 'visiting', visitCount: (released.visitCount || 0) + 1, lastVisitAt: now }
    })
    await userRef.update({ data: { _lastReleasedVisitorAt: now } })
    return added._id
  })
}

async function readDocument(ref) {
  try {
    return (await ref.get()).data || null
  } catch (e) {
    if (e.errCode === -502001 && /not exist|not found|不存在/i.test(e.message || e.errMsg || '')) return null
    throw e
  }
}

async function writeVisitLog(store, openid, entry) {
  await store.collection('visitLogs').add({
    data: { _openid: openid, createdAt: Date.now(), ...entry }
  })
}

async function finishVisit(tx, visit, now, { adopted = false, released } = {}) {
  if (visit.loggedInbound) return
  const visitRef = tx.collection('visits').doc(visit._id)
  if (visit.releasedId && !adopted && visit.status === 'active') {
    const releasedRef = tx.collection('released_cats').doc(visit.releasedId)
    const current = await readDocument(releasedRef)
    if (current && current.status === 'visiting') {
      await releasedRef.update({ data: { status: 'wandering' } })
    }
  }
  if (visit.hostOpenId && !visit.hostOpenId.startsWith('mock_')) {
    const leaveAt = adopted ? now : visit.leaveAt || now
    await writeVisitLog(tx, visit.hostOpenId, {
      direction: 'inbound',
      visitId: visit._id,
      breed: visit.breed || '小猫',
      name: (released && released.name) || visit.name || '',
      cutoutPath: visit.cutoutPath || '',
      behaviorText: visit.behaviorText || '',
      ...(Number.isInteger(visit.behaviorIndex) ? { behaviorIndex: visit.behaviorIndex } : {}),
      ...(visit.friend ? { friend: visit.friend } : {}),
      distanceKm: visit.distanceKm || 0,
      fromReleased: !!visit.fromReleased,
      pet: !!visit.petByHost,
      fed: !!visit.fedByHost,
      adopted: adopted || !!visit.adoptedByHost,
      arriveAt: visit.arriveAt || 0,
      leaveAt,
      at: leaveAt
    })
  }
  const data = { status: 'left', loggedInbound: true }
  if (adopted) Object.assign(data, { seenLeft: true, adoptedByHost: true, canAdopt: false })
  await visitRef.update({ data })
}

async function expireHostVisits(openid, now) {
  const visits = db.collection('visits')
  const { data = [] } = await visits.where({ hostOpenId: openid, status: 'active' }).limit(100).get()
  for (const candidate of data) {
    if (now < candidate.leaveAt) continue
    await db.runTransaction(async (tx) => {
      const visit = await readDocument(tx.collection('visits').doc(candidate._id))
      if (visit && visit.status === 'active' && now >= visit.leaveAt) {
        await finishVisit(tx, visit, now)
      }
    })
  }
}

async function backfillInboundVisitLogs(openid) {
  const { data = [] } = await db.collection('visits')
    .where({ hostOpenId: openid, status: 'left' })
    .orderBy('leaveAt', 'desc').limit(100).get()
  for (const candidate of data) {
    if (candidate.loggedInbound) continue
    await db.runTransaction(async (tx) => {
      const visit = await readDocument(tx.collection('visits').doc(candidate._id))
      if (visit && visit.status === 'left') await finishVisit(tx, visit, Date.now())
    })
  }
}

function releasedStatusView(item, visitingMap) {
  if (!item) return item
  if (item.status === 'adopted') {
    return { ...item, status: 'adopted', statusLabel: '已被收养', statusTone: 'adopted' }
  }
  if (item.status === 'visiting' || (visitingMap && visitingMap[item._id])) {
    return { ...item, status: 'visiting', statusLabel: '正在别人家串门', statusTone: 'visiting' }
  }
  return { ...item, status: 'wandering', statusLabel: '流浪中', statusTone: 'wandering' }
}

async function listMyReleased(openid) {
  let list = []
  try {
    const res = await db
      .collection('released_cats')
      .where({ releasedBy: openid })
      .orderBy('releasedAt', 'desc')
      .limit(50)
      .get()
    list = res.data || []
  } catch (e) {
    const res = await db.collection('released_cats').where({ releasedBy: openid }).limit(50).get()
    list = (res.data || []).sort((a, b) => (b.releasedAt || 0) - (a.releasedAt || 0))
  }

  const visitingMap = {}
  try {
    const active = await db.collection('visits').where({ status: 'active', fromReleased: true }).limit(50).get()
    ;(active.data || []).forEach((v) => {
      if (v.releasedId) visitingMap[v.releasedId] = true
    })
  } catch (e) {
    /* ignore */
  }

  return { list: list.map((item) => releasedStatusView(item, visitingMap)) }
}

async function adoptVisitor(openid, { visitId, geo, placeText } = {}) {
  if (!visitId) return { error: 'bad visit', code: 'BAD_REQUEST' }
  const nextGeo = normalizeGeo(geo)
  if (!nextGeo) {
    return { error: '需要位置信息才能收养', code: 'GEO_REQUIRED' }
  }
  await ensureUser(openid)
  const result = await db.runTransaction(async (tx) => {
    const now = Date.now()
    const visit = await readDocument(tx.collection('visits').doc(visitId))
    if (!visit || visit.hostOpenId !== openid) {
      return { error: '小猫已经走了', code: 'GONE' }
    }
    if (!visit.fromReleased || !visit.releasedId) {
      return { error: '这只不是放生猫', code: 'BAD_REQUEST' }
    }
    const releasedRef = tx.collection('released_cats').doc(visit.releasedId)
    const released = await readDocument(releasedRef)
    if (visit.adoptedByHost && released && released.adoptedBy === openid && released.adoptedCardId) {
      const card = await readDocument(tx.collection('cards').doc(released.adoptedCardId))
      if (cardBelongsTo(card, openid)) return { card, toast: '你收养了它，它有新家了' }
    }
    if (visit.status !== 'active' || now >= visit.leaveAt) {
      return { error: '小猫已经走了', code: 'GONE' }
    }
    if (!released || released.status === 'adopted') {
      return { error: '它已经被收养了', code: 'GONE' }
    }

    const doc = buildCard(openid, {
      cutoutPath: released.cutoutFileId || released.cutoutPath || visit.cutoutPath || '',
      originalPath: released.originalFileId || released.originalPath || '',
      cutoutFileId: released.cutoutFileId || '',
      originalFileId: released.originalFileId || '',
      breed: released.breed || visit.breed || '待识别',
      name: released.name || '',
      confidence: 100,
      note: '从门口收养的流浪猫',
      placeText: placeText || '我家门口',
      intimacy: 18,
      mattingFailed: !(released.cutoutFileId || released.cutoutPath)
    }, nextGeo)
    doc.adoptedFromReleasedId = released._id
    const added = await tx.collection('cards').add({ data: doc })
    await releasedRef.update({
      data: { status: 'adopted', adoptedBy: openid, adoptedAt: now, adoptedCardId: added._id }
    })
    await finishVisit(tx, visit, now, { adopted: true, released })
    return { card: { _id: added._id, ...doc }, toast: '你收养了它，它有新家了' }
  })
  if (result.card) await recomputeStats(openid).catch((e) => console.warn('adoption stats fail', e))
  return result
}

async function pickVisitHost(excludeOpenId) {
  const res = await db.collection('users').where({ 'settings.allowVisitors': true }).limit(50).get()
  const candidates = (res.data || []).filter((u) => u._openid !== excludeOpenId)
  if (!candidates.length) return null
  // 过滤已有活跃访客的小屋
  const shuffled = candidates.sort(() => Math.random() - 0.5)
  for (const host of shuffled) {
    const active = await db.collection('visits').where({ hostOpenId: host._openid, status: 'active' }).count()
    if ((active.total || 0) === 0) return host
  }
  return null
}

function needsOutingTick(user, now) {
  const outing = user.outing
  if (outing.status === 'out') return now - outing.leftAt >= outing.travelDuration
  if (outing.status === 'visiting') return now - outing.visitArriveAt >= outing.visitDuration
  const cardId = user.displayCardId || ''
  if (!cardId) return outing.status !== 'idle'
  if (!user.settings.allowMyCatOut) return false
  return outing.status !== 'home' || outing.cardId !== cardId ||
    now - outing.homeSince >= outing.homeDuration
}

async function advanceOuting(openid, user, now) {
  if (!needsOutingTick(user, now)) return user
  const host = user.outing.status === 'out' ? await pickVisitHost(openid) : null
  const meetsFriend = user.outing.status === 'out' && Math.random() < 0.3
  return db.runTransaction(async (tx) => {
    const userRef = tx.collection('users').doc(user._id)
    const current = normalizeUser((await userRef.get()).data)
    if (!needsOutingTick(current, now)) return current
    const outing = current.outing
    const cardId = isAway(outing) ? outing.cardId : current.displayCardId
    const card = cardId ? await readDocument(tx.collection('cards').doc(cardId)) : null
    const owned = cardBelongsTo(card, openid)
    if (!owned && !isAway(outing) && cardId) return current
    if (!owned) {
      Object.assign(outing, { status: 'idle', cardId: '', visitId: '', hostKey: '' })
    } else if (!isAway(outing) && (outing.status !== 'home' || outing.cardId !== cardId)) {
      Object.assign(outing, {
        status: 'home', cardId, homeSince: now, homeDuration: randBetweenHours(6, 12)
      })
    } else if (outing.status === 'home') {
      Object.assign(outing, {
        status: 'out', leftAt: now, travelDuration: randBetweenHours(2, 6),
        pet: false, fed: false, visitId: '', hostKey: ''
      })
    } else if (outing.status === 'out') {
      const picked = pickBehavior(outing.lastBehaviorIndex)
      const distanceKm = Math.round((0.5 + Math.random() * 7.5) * 10) / 10
      const visitDuration = randBetweenHours(2, 6)
      const currentHost = host ? await readDocument(tx.collection('users').doc(host._id)) : null
      const visitingHost = currentHost && currentHost.settings && currentHost.settings.allowVisitors ? currentHost : null
      const hostOpenId = visitingHost ? visitingHost._openid : 'mock_' + openid
      let friend = null
      if (meetsFriend) {
        friend = visitingHost
          ? await pickOutingFriend(tx, visitingHost)
          : { name: '麦团', image: '/assets/illus/map-cat-2.png', kind: 'illustration' }
      }
      const added = await tx.collection('visits').add({
        data: {
          hostOpenId, ownerOpenId: openid, guestCardId: cardId,
          breed: card.breed || '小猫',
          name: card.name || '',
          cutoutPath: card.cutoutFileId || card.cutoutPath || card.originalFileId || card.originalPath || '',
          behaviorText: picked.text, behaviorIndex: picked.index, friend,
          distanceKm, arriveAt: now, leaveAt: now + visitDuration,
          status: 'active', petByHost: false, fedByHost: false, seenLeft: false
        }
      })
      Object.assign(outing, {
        status: 'visiting', behaviorIndex: picked.index, behaviorText: picked.text,
        lastBehaviorIndex: picked.index, distanceKm, visitArriveAt: now, visitDuration,
        visitId: added._id, hostKey: hostOpenId
      })
    } else if (outing.status === 'visiting') {
      const visit = outing.visitId
        ? await readDocument(tx.collection('visits').doc(outing.visitId))
        : null
      const ownVisit = visit && visit.ownerOpenId === openid && visit.guestCardId === cardId ? visit : null
      if (ownVisit) {
        outing.pet = outing.pet || !!ownVisit.petByHost
        outing.fed = outing.fed || !!ownVisit.fedByHost
        await finishVisit(tx, ownVisit, now)
      }
      const log = {
        cardId, visitId: outing.visitId || '', distanceKm: outing.distanceKm || 0, behaviorText: outing.behaviorText || '',
        behaviorIndex: Number.isInteger(outing.behaviorIndex) ? outing.behaviorIndex : -1,
        catImage: card.cutoutFileId || card.cutoutPath || card.originalFileId || card.originalPath || '',
        friend: (ownVisit && ownVisit.friend) || null,
        simulated: !!(ownVisit && ownVisit.hostOpenId === 'mock_' + openid),
        pet: !!outing.pet, fed: !!outing.fed, leftAt: outing.leftAt, returnedAt: now
      }
      await tx.collection('outingLogs').add({ data: { _openid: openid, ...log } })
      await writeVisitLog(tx, openid, {
        ...log, direction: 'outbound',
        breed: card.breed || '小猫', name: card.name || '',
        cutoutPath: card.cutoutFileId || card.cutoutPath || '',
        leaveAt: now, at: now
      })
      const nextCardId = current.displayCardId || ''
      Object.assign(outing, {
        unreadReport: buildReport(outing, card, current.settings.showDistance, log),
        status: nextCardId ? 'home' : 'idle', cardId: nextCardId, homeSince: now,
        homeDuration: randBetweenHours(6, 12), visitId: '', hostKey: ''
      })
    }
    await userRef.update({ data: { outing: _.set(outing) } })
    return current
  })
}

async function tickAndGetRoomState(openid) {
  const now = Date.now()
  const current = await ensureUser(openid)
  await expireHostVisits(openid, now)
  const user = await advanceOuting(openid, current, now)
  const { card: displayCard } = await getCard(openid, user.displayCardId)

  // 放生池小猫有机会来串门
  try {
    await maybeSpawnReleasedVisitor(openid, now)
  } catch (e) {
    console.warn('spawn released visitor fail', e)
  }

  const showDistance = (user.settings || defaultSettings()).showDistance !== false
  const curOuting = user.outing || {}
  const outingActive = curOuting.status === 'out' || curOuting.status === 'visiting'
  const outingCardId = outingActive ? curOuting.cardId || user.displayCardId || '' : ''
  let outingCatName = ''
  if (outingCardId) {
    try {
      const outCardRes = await db.collection('cards').doc(outingCardId).get()
      const outCard = outCardRes && outCardRes.data
      if (outCard) outingCatName = (outCard.name || '').trim() || outCard.breed || '小猫'
    } catch (e) {
      outingCatName = '小猫'
    }
  }
  const myCatStatus = !displayCard && !outingCardId
    ? 'none'
    : outingActive
      ? 'away'
      : displayCard
        ? 'home'
        : 'none'
  const outingPhase =
    outingActive
      ? curOuting.status === 'visiting'
        ? 'visiting'
        : 'out'
      : myCatStatus === 'home'
        ? 'home'
        : 'none'

  const activeRes = await db.collection('visits').where({ hostOpenId: openid, status: 'active' }).limit(1).get()
  const activeVisitor = (activeRes.data && activeRes.data[0]) || null
  let leftTrace = null
  if (!activeVisitor) {
    const leftRes = await db
      .collection('visits')
      .where({ hostOpenId: openid, status: 'left', seenLeft: false })
      .orderBy('leaveAt', 'desc')
      .limit(1)
      .get()
    leftTrace = (leftRes.data && leftRes.data[0]) || null
  }

  const unreadReport = user.outing.unreadReport || null
  const day = todayKey(now)
  const autoShowReport = !!(unreadReport && user.outing.lastAutoReportDay !== day)

  return {
    user,
    displayCard,
    myCatStatus,
    outingPhase,
    outingCardId,
    outingCatName,
    unreadBadge: unreadReport ? 1 : 0,
    unreadReport,
    autoShowReport,
    visitor: activeVisitor
      ? {
          id: activeVisitor._id,
          source: 'cloud',
          breed: activeVisitor.breed,
          cutoutPath: activeVisitor.cutoutPath,
          behaviorText: activeVisitor.behaviorText,
          distanceLabel: formatDistanceLabel(activeVisitor.distanceKm, showDistance),
          petByHost: !!activeVisitor.petByHost,
          fedByHost: !!activeVisitor.fedByHost,
          fromReleased: !!activeVisitor.fromReleased,
          releasedId: activeVisitor.releasedId || '',
          canAdopt: !!(activeVisitor.fromReleased && activeVisitor.releasedId && !activeVisitor.adoptedByHost)
        }
      : null,
    leftTrace: leftTrace
      ? {
          id: leftTrace._id,
          breed: leftTrace.breed,
          behaviorText: leftTrace.behaviorText,
          distanceLabel: formatDistanceLabel(leftTrace.distanceKm, showDistance)
        }
      : null
  }
}

async function interactVisitor(openid, { visitId, interaction }) {
  if (!visitId || (interaction !== 'pet' && interaction !== 'feed')) {
    return { error: '无效的访客操作', code: 'BAD_REQUEST' }
  }
  const user = await ensureUser(openid)
  return db.runTransaction(async (tx) => {
    const visitRef = tx.collection('visits').doc(visitId)
    const visit = await readDocument(visitRef)
    if (!visit || visit.hostOpenId !== openid || visit.status !== 'active' || Date.now() >= visit.leaveAt) {
      return { error: '小猫已经走了', code: 'GONE' }
    }
    if (interaction === 'pet') {
      if (visit.petByHost) return { toast: '' }
      await visitRef.update({ data: { petByHost: true } })
      return { toast: '你摸了摸它' }
    }
    if (visit.fedByHost) return { toast: '' }
    const userRef = tx.collection('users').doc(user._id)
    const { data: current } = await userRef.get()
    const day = todayKey()
    if (current.fedDate === day) return { error: '今日已送过猫粮', code: 'FED_LIMIT' }
    await visitRef.update({ data: { fedByHost: true } })
    await userRef.update({ data: { fedDate: day } })
    return { toast: '你给了它一颗猫粮' }
  })
}

async function dismissReport(openid, { auto }) {
  const user = await ensureUser(openid)
  const data = { 'outing.unreadReport': null }
  if (auto) data['outing.lastAutoReportDay'] = todayKey()
  await db.collection('users').doc(user._id).update({ data })
  return { ok: true }
}

async function dismissLeftTrace(openid, { visitId }) {
  if (!visitId) return { error: '缺少 visitId', code: 'BAD_REQUEST' }
  // 只能关闭自己小屋（host）的来访痕迹
  return db.runTransaction(async (tx) => {
    const ref = tx.collection('visits').doc(visitId)
    const visit = await readDocument(ref)
    if (!visit || visit.hostOpenId !== openid || visit.status !== 'left') {
      return { error: 'visit not found', code: 'NOT_FOUND' }
    }
    await finishVisit(tx, visit, Date.now())
    await ref.update({ data: { seenLeft: true } })
    return { ok: true }
  })
}

async function listOutingLogs(openid, { cardId }) {
  const user = await ensureUser(openid)
  const showDistance = (user.settings || defaultSettings()).showDistance !== false
  const res = await db
    .collection('outingLogs')
    .where({ _openid: openid, cardId })
    .orderBy('returnedAt', 'desc')
    .get()
  const logs = (res.data || []).map((l) => {
    let interactLine = ''
    if (l.pet) interactLine = '有人摸了摸它。'
    if (l.fed) interactLine += '有人给了它一颗猫粮。'
    return {
      ...l,
      distanceLabel: formatDistanceLabel(l.distanceKm, showDistance),
      interactLine
    }
  })
  return { logs }
}

async function listVisitLogs(openid, { direction } = {}) {
  if (direction !== 'outbound') {
    await expireHostVisits(openid, Date.now())
    await backfillInboundVisitLogs(openid).catch((e) => console.warn('backfill inbound visit logs fail', e))
  }
  const user = await ensureUser(openid)
  const showDistance = (user.settings || defaultSettings()).showDistance !== false
  let list = []
  try {
    const res = await db
      .collection('visitLogs')
      .where({ _openid: openid })
      .orderBy('at', 'desc')
      .limit(100)
      .get()
    list = res.data || []
  } catch (e) {
    const res = await db.collection('visitLogs').where({ _openid: openid }).limit(100).get()
    list = (res.data || []).sort((a, b) => (b.at || 0) - (a.at || 0))
  }
  if (direction === 'inbound' || direction === 'outbound') {
    list = list.filter((l) => l.direction === direction)
  }
  const logs = list.map((l) => {
    const distanceLabel = formatDistanceLabel(l.distanceKm, showDistance)
    let interactLine = ''
    if (l.pet) interactLine += '有人摸了摸它。'
    if (l.fed) interactLine += '有人给了它一颗猫粮。'
    if (l.adopted) interactLine += '被收留进了新家。'
    const title =
      l.direction === 'outbound'
        ? `你的${l.name || (['待识别', '识别中…', '未知小动物'].indexOf(l.breed) >= 0 ? '' : l.breed) || '小猫'}去串门了`
        : `${l.fromReleased ? '流浪的' : ''}${l.name || l.breed || '小猫'}来过`
    const summary =
      l.direction === 'outbound' ? `去了「${distanceLabel}」` : `来自「${distanceLabel}」`
    return {
      ...l,
      distanceLabel,
      interactLine,
      title,
      summary,
      directionLabel: l.direction === 'outbound' ? '去串门' : '来串门'
    }
  })
  return { logs }
}

exports.main = async (event) => {
  const wxContext = cloud.getWXContext()
  const openid = wxContext.OPENID
  const action = event.action
  try {
    switch (action) {
      case 'login':
        return await login(openid)
      case 'getProfile':
        return await getProfile(openid)
      case 'updateProfile':
        return await updateProfile(openid, event)
      case 'recognize':
        return await recognize(event)
      case 'matting':
        return await runMatting(event, openid)
      case 'embedCatPhoto':
        return await embedCatPhoto(openid, event.imageBase64)
      case 'listCards':
        return await listCards(openid, event)
      case 'repairOrphanCards':
        return await repairOrphanCards(openid)
      case 'getCard':
        return await getCard(openid, event.cardId)
      case 'createCard':
        return await createCard(openid, event)
      case 'updateCard':
        return await updateCard(openid, event.cardId, event.patch || {})
      case 'requestBreedChange':
        return await requestBreedChange(openid, event)
      case 'reviewBreedChange':
        return await reviewBreedChange(openid, event)
      case 'listBreedReviews':
        return await listBreedReviews(openid, event)
      case 'releaseCard':
        return await releaseCard(openid, event.cardId)
      case 'listMyReleased':
        return await listMyReleased(openid)
      case 'adoptVisitor':
        return await adoptVisitor(openid, event)
      case 'listMemories':
        return await listMemories(openid, event.cardId)
      case 'createMemory':
        return await createMemory(openid, event)
      case 'deleteMemory':
        return await deleteMemory(openid, event.memoryId)
      case 'breedFilters':
        return await breedFilters(openid)
      case 'reportDuelResult':
        return await reportDuelResult(openid, event)
      case 'getRoomState':
        return await tickAndGetRoomState(openid)
      case 'interactVisitor':
        return await interactVisitor(openid, event)
      case 'dismissReport':
        return await dismissReport(openid, event)
      case 'dismissLeftTrace':
        return await dismissLeftTrace(openid, event)
      case 'listOutingLogs':
        return await listOutingLogs(openid, event)
      case 'listVisitLogs':
        return await listVisitLogs(openid, event)
      default:
        return { error: `unknown action: ${action}`, code: 'BAD_ACTION' }
    }
  } catch (e) {
    console.error(action, e)
    return { error: e.message || 'server error', code: 'SERVER' }
  }
}
