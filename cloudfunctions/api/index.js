/**
 * 统一云函数：action 路由
 * 集合：users / cards / memories / duels（duels 仅预留）
 */
const cloud = require('wx-server-sdk')

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
  if (!geo || typeof geo.lat !== 'number' || typeof geo.lng !== 'number') return null
  if (!Number.isFinite(geo.lat) || !Number.isFinite(geo.lng)) return null
  return { lat: geo.lat, lng: geo.lng }
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

function normalizeUser(user) {
  if (!user.settings) user.settings = defaultSettings()
  if (!user.outing) user.outing = defaultOuting()
  if (!user.fedDate) user.fedDate = ''
  return user
}

async function ensureUser(openid) {
  const col = db.collection('users')
  const found = await col.where({ _openid: openid }).limit(1).get()
  if (found.data && found.data.length) return normalizeUser(found.data[0])
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

async function saveUser(user) {
  const { _id, _openid, ...data } = user
  await db.collection('users').doc(_id).update({
    data: {
      settings: data.settings,
      outing: data.outing,
      fedDate: data.fedDate || '',
      displayCardId: data.displayCardId,
      roomMateIds: Array.isArray(data.roomMateIds) ? data.roomMateIds : [],
      roomBackgroundId: data.roomBackgroundId,
      nickName: data.nickName,
      avatarUrl: data.avatarUrl,
      privacyAgreedAt: data.privacyAgreedAt,
      stats: data.stats,
      fuzzyGeo: data.fuzzyGeo || null
    }
  })
}

async function recomputeStats(openid) {
  const _ = db.command
  let cards = []
  try {
    const cardsRes = await db
      .collection('cards')
      .where(_.or([{ _openid: openid }, { ownerOpenId: openid }]))
      .get()
    cards = cardsRes.data || []
  } catch (e) {
    const cardsRes = await db.collection('cards').where({ _openid: openid }).get()
    cards = cardsRes.data || []
  }
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
    data.settings = Object.assign({}, user.settings || defaultSettings(), payload.settings)
  }
  if (payload.displayCardId && payload.displayCardId !== user.displayCardId) {
    data.outing = Object.assign({}, user.outing || defaultOuting(), {
      status: 'home',
      cardId: payload.displayCardId,
      homeSince: Date.now(),
      homeDuration: randBetweenHours(6, 12)
    })
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

async function listCards(openid, { limit = 100, breed } = {}) {
  // 先走单字段 _openid（有索引、快）；空再补查 ownerOpenId。不做每次自动 repair。
  let q = db.collection('cards').where({ _openid: openid })
  if (breed && breed !== '全部') {
    q = db.collection('cards').where({ _openid: openid, breed })
  }
  let res = await q.orderBy('shotAt', 'desc').limit(limit).get()
  let cards = res.data || []

  if (!cards.length) {
    try {
      let q2 = db.collection('cards').where({ ownerOpenId: openid })
      if (breed && breed !== '全部') {
        q2 = db.collection('cards').where({ ownerOpenId: openid, breed })
      }
      const res2 = await q2.orderBy('shotAt', 'desc').limit(limit).get()
      cards = res2.data || []
    } catch (e) {
      console.warn('listCards ownerOpenId query fail', e)
    }
  }
  return { cards }
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
  const recognizedBreed = normalizeRecognizedBreedCloud(
    payload.recognizedBreed !== undefined ? payload.recognizedBreed : payload.breed
  )
  let breed = clampText(payload.breed || '', 20) || UNKNOWN_LABEL
  let pendingBreed = ''
  let breedReviewStatus = ''
  let breedReviewId = ''
  if (payload.breedManual && breed && (!recognizedBreed || breed !== recognizedBreed)) {
    pendingBreed = breed
    breedReviewStatus = 'pending'
    breed = recognizedBreed || '待识别'
  }
  // 幂等：客户端带本地卡 id，重试/超时后再次提交时直接返回已建的卡
  const clientId = clampText(payload.clientId || '', 64)
  if (clientId) {
    try {
      const dup = await db.collection('cards').where({ _openid: openid, clientId }).limit(1).get()
      if (dup.data && dup.data[0]) return { card: dup.data[0], deduped: true }
    } catch (e) {
      /* ignore */
    }
  }
  const doc = {
    _openid: openid,
    ownerOpenId: openid,
    clientId,
    cutoutFileId: payload.cutoutFileId || '',
    originalFileId: payload.originalFileId || '',
    cutoutPath: payload.cutoutPath || '',
    originalPath: payload.originalPath || '',
    breed,
    recognizedBreed,
    pendingBreed,
    breedReviewStatus,
    breedReviewId,
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
  const addRes = await db.collection('cards').add({ data: doc })
  if (pendingBreed) {
    const rev = await db.collection('breed_reviews').add({
      data: {
        _openid: openid,
        cardId: addRes._id,
        fromBreed: breed,
        toBreed: pendingBreed,
        recognizedBreed,
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
  if (patch.geo !== undefined) data.geo = patch.geo
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
  const doc = {
    _openid: openid,
    ownerOpenId: openid,
    cardId: payload.cardId,
    text: clampText(payload.text, 200),
    imageFileId: payload.imageFileId || '',
    imagePath: payload.imagePath || '',
    createdAt: Date.now()
  }
  const addRes = await db.collection('memories').add({ data: doc })
  const countRes = await db.collection('memories').where({ cardId: payload.cardId }).count()
  await db.collection('cards').doc(payload.cardId).update({ data: { memoryCount: countRes.total } })
  await recomputeStats(openid)
  return { memory: { _id: addRes._id, ...doc } }
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
  const res = await db.collection('cards').where({ _openid: openid }).get()
  const counts = {}
  ;(res.data || []).forEach((c) => {
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

function buildReport(outing, breed, showDistance) {
  const distLabel = formatDistanceLabel(outing.distanceKm, showDistance)
  let interactLine = '它在那里待了一会儿。'
  if (outing.pet) interactLine = '有人摸了摸它。'
  if (outing.fed) interactLine = outing.pet ? '有人摸了摸它。有人给了它一颗猫粮。' : '有人给了它一颗猫粮。'
  return {
    title: '🐾 它回来了',
    distanceLine: `你的${breed || '小猫'}去了一趟「${distLabel}」`,
    behaviorLine: outing.behaviorText || '',
    interactLine,
    createdAt: Date.now()
  }
}

async function releaseCard(openid, cardId) {
  const { card } = await getCard(openid, cardId)
  if (!card) return { error: 'card not found', code: 'NOT_FOUND' }
  if (card.breedReviewStatus === 'pending' || card.pendingBreed) {
    return { error: '审核中不能放生', code: 'PENDING' }
  }

  await db.collection('released_cats').add({
    data: {
      _openid: openid,
      ownerOpenId: openid,
      cardId: card._id,
      breed: card.breed || '待识别',
      name: card.name || '',
      cutoutPath: card.cutoutPath || '',
      originalPath: card.originalPath || '',
      cutoutFileId: card.cutoutFileId || '',
      originalFileId: card.originalFileId || '',
      releasedBy: openid,
      releasedAt: Date.now(),
      visitCount: 0,
      lastVisitAt: 0,
      status: 'wandering',
      adoptedBy: '',
      adoptedAt: 0,
      adoptedCardId: ''
    }
  })

  try {
    await db.collection('cards').doc(cardId).remove()
  } catch (e) {
    console.warn('release remove card fail', e)
  }

  const user = await ensureUser(openid)
  if (user.displayCardId === cardId) {
    const rest = await listCards(openid, { limit: 1 })
    const next = (rest.cards || [])[0]
    const data = {
      displayCardId: next ? next._id : '',
      outing: Object.assign({}, user.outing || defaultOuting(), next
        ? {
            status: 'home',
            cardId: next._id,
            homeSince: Date.now(),
            homeDuration: randBetweenHours(6, 12)
          }
        : { status: 'idle', cardId: '' })
    }
    await db.collection('users').doc(user._id).update({ data })
  }
  await recomputeStats(openid)
  return { ok: true, toast: '它自由了。以后也许会去别人家串门。' }
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

  const leaveAt = now + randBetweenHours(1, 4)
  const add = await db.collection('visits').add({
    data: {
      hostOpenId: openid,
      ownerOpenId: pick.releasedBy || 'released',
      guestCardId: pick.cardId || '',
      releasedId: pick._id,
      breed: pick.breed || '待识别',
      cutoutPath: pick.cutoutFileId || pick.cutoutPath || '',
      behaviorText,
      distanceKm: Math.round((0.5 + Math.random() * 7.5) * 10) / 10,
      arriveAt: now,
      leaveAt,
      status: 'active',
      petByHost: false,
      fedByHost: false,
      seenLeft: false,
      fromReleased: true,
      canAdopt: true
    }
  })

  try {
    await db.collection('released_cats').doc(pick._id).update({
      data: {
        status: 'visiting',
        visitCount: (pick.visitCount || 0) + 1,
        lastVisitAt: now
      }
    })
  } catch (e) {
    /* ignore */
  }

  await db.collection('users').doc(user._id).update({
    data: { _lastReleasedVisitorAt: now }
  })

  return add._id
}

async function writeVisitLog(openid, entry) {
  await db.collection('visitLogs').add({
    data: {
      _openid: openid,
      createdAt: Date.now(),
      ...entry
    }
  })
}

async function expireHostVisits(openid, now) {
  const res = await db.collection('visits').where({ hostOpenId: openid, status: 'active' }).get()
  for (const v of res.data || []) {
    if (now >= v.leaveAt) {
      await db.collection('visits').doc(v._id).update({ data: { status: 'left', loggedInbound: true } })
      try {
        await writeVisitLog(openid, {
          direction: 'inbound',
          visitId: v._id,
          breed: v.breed || '小猫',
          name: v.name || '',
          cutoutPath: v.cutoutPath || '',
          behaviorText: v.behaviorText || '',
          distanceKm: v.distanceKm || 0,
          fromReleased: !!v.fromReleased,
          pet: !!v.petByHost,
          fed: !!v.fedByHost,
          adopted: !!v.adoptedByHost,
          arriveAt: v.arriveAt || 0,
          leaveAt: v.leaveAt || now,
          at: v.leaveAt || now
        })
      } catch (e) {
        console.warn('write inbound visitLog fail', e)
      }
      if (v.releasedId) {
        try {
          const rel = await db.collection('released_cats').doc(v.releasedId).get()
          if (rel.data && rel.data.status === 'visiting') {
            await db.collection('released_cats').doc(v.releasedId).update({ data: { status: 'wandering' } })
          }
        } catch (e) {
          /* ignore */
        }
      }
      if (v.ownerOpenId) {
        const owners = await db.collection('users').where({ _openid: v.ownerOpenId }).limit(1).get()
        const owner = owners.data && owners.data[0]
        if (owner && owner.outing && owner.outing.visitId === v._id) {
          const outing = owner.outing
          if (v.petByHost) outing.pet = true
          if (v.fedByHost) outing.fed = true
          await db.collection('users').doc(owner._id).update({ data: { outing } })
        }
      }
    }
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
  const res = await db.collection('visits').doc(visitId).get()
  const visit = res.data
  if (!visit || visit.hostOpenId !== openid || visit.status !== 'active') {
    return { error: '小猫已经走了', code: 'GONE' }
  }
  if (!visit.fromReleased || !visit.releasedId) {
    return { error: '这只不是放生猫', code: 'BAD_REQUEST' }
  }

  let released = null
  try {
    const r = await db.collection('released_cats').doc(visit.releasedId).get()
    released = r.data
  } catch (e) {
    return { error: '找不到放生记录', code: 'NOT_FOUND' }
  }
  if (!released || released.status === 'adopted') {
    return { error: '它已经被收养了', code: 'GONE' }
  }

  const created = await createCard(openid, {
    cutoutPath: released.cutoutFileId || released.cutoutPath || visit.cutoutPath || '',
    originalPath: released.originalFileId || released.originalPath || '',
    cutoutFileId: released.cutoutFileId || '',
    originalFileId: released.originalFileId || '',
    breed: released.breed || visit.breed || '待识别',
    name: released.name || '',
    confidence: 100,
    shotAt: Date.now(),
    note: '从门口收养的流浪猫',
    placeText: placeText || '我家门口',
    geo: nextGeo,
    intimacy: 18,
    mattingFailed: !(released.cutoutFileId || released.cutoutPath)
  })
  if (created && created.error) return created

  await db.collection('released_cats').doc(visit.releasedId).update({
    data: {
      status: 'adopted',
      adoptedBy: openid,
      adoptedAt: Date.now(),
      adoptedCardId: (created.card && created.card._id) || ''
    }
  })
  await db.collection('visits').doc(visitId).update({
    data: { status: 'left', seenLeft: true, adoptedByHost: true, canAdopt: false, loggedInbound: true }
  })
  try {
    await writeVisitLog(openid, {
      direction: 'inbound',
      visitId,
      breed: visit.breed || released.breed || '小猫',
      name: released.name || '',
      cutoutPath: visit.cutoutPath || released.cutoutPath || '',
      behaviorText: visit.behaviorText || '',
      distanceKm: visit.distanceKm || 0,
      fromReleased: true,
      pet: !!visit.petByHost,
      fed: !!visit.fedByHost,
      adopted: true,
      arriveAt: visit.arriveAt || 0,
      leaveAt: Date.now(),
      at: Date.now()
    })
  } catch (e) {
    console.warn('adopt visitLog fail', e)
  }

  return {
    card: created.card,
    toast: '你收养了它，它有新家了'
  }
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

async function tickAndGetRoomState(openid) {
  const now = Date.now()
  let user = await ensureUser(openid)
  await expireHostVisits(openid, now)

  const displayId = user.displayCardId
  let displayCard = null
  if (displayId) {
    const c = await getCard(openid, displayId)
    displayCard = c.card
  }

  const outing = user.outing || defaultOuting()
  const settings = user.settings || defaultSettings()
  let dirty = false

  if (!displayCard || !settings.allowMyCatOut) {
    if (outing.status === 'out' || outing.status === 'visiting') {
      outing.status = 'idle'
      outing.cardId = ''
      dirty = true
    }
  } else {
    if (outing.status === 'idle' || !outing.cardId || outing.cardId !== displayCard._id) {
      if (outing.status === 'home' && outing.cardId !== displayCard._id) {
        outing.homeSince = now
        outing.homeDuration = randBetweenHours(6, 12)
      }
      if (outing.status === 'idle' || !outing.cardId) {
        outing.status = 'home'
        outing.homeSince = now
        outing.homeDuration = randBetweenHours(6, 12)
      }
      outing.cardId = displayCard._id
      dirty = true
    }

    if (outing.status === 'home' && now - outing.homeSince >= outing.homeDuration) {
      outing.status = 'out'
      outing.leftAt = now
      outing.travelDuration = randBetweenHours(2, 6)
      outing.pet = false
      outing.fed = false
      outing.visitId = ''
      dirty = true
    }

    if (outing.status === 'out' && now - outing.leftAt >= outing.travelDuration) {
      const picked = pickBehavior(outing.lastBehaviorIndex)
      outing.behaviorIndex = picked.index
      outing.behaviorText = picked.text
      outing.lastBehaviorIndex = picked.index
      outing.distanceKm = Math.round((0.5 + Math.random() * 7.5) * 10) / 10
      outing.visitArriveAt = now
      outing.visitDuration = randBetweenHours(2, 6)
      outing.status = 'visiting'
      const host = await pickVisitHost(openid)
      const hostOpenId = host ? host._openid : `mock_${openid}`
      const add = await db.collection('visits').add({
        data: {
          hostOpenId,
          ownerOpenId: openid,
          guestCardId: displayCard._id,
          breed: displayCard.breed,
          cutoutPath: displayCard.cutoutPath || displayCard.originalPath || '',
          behaviorText: outing.behaviorText,
          distanceKm: outing.distanceKm,
          arriveAt: now,
          leaveAt: now + outing.visitDuration,
          status: 'active',
          petByHost: false,
          fedByHost: false,
          seenLeft: false
        }
      })
      outing.visitId = add._id
      outing.hostKey = hostOpenId
      dirty = true
    }

    if (outing.status === 'visiting' && now - outing.visitArriveAt >= outing.visitDuration) {
      // 同步互动
      if (outing.visitId) {
        try {
          const v = await db.collection('visits').doc(outing.visitId).get()
          if (v.data) {
            if (v.data.petByHost) outing.pet = true
            if (v.data.fedByHost) outing.fed = true
            if (v.data.status === 'active') {
              await db.collection('visits').doc(outing.visitId).update({ data: { status: 'left' } })
            }
          }
        } catch (e) {
          /* ignore */
        }
      }
      outing.unreadReport = buildReport(outing, displayCard.breed, settings.showDistance)
      await db.collection('outingLogs').add({
        data: {
          // 云函数里 add 不会自动带 _openid，listOutingLogs 按它过滤，必须手动写
          _openid: openid,
          cardId: outing.cardId,
          distanceKm: outing.distanceKm,
          behaviorText: outing.behaviorText,
          pet: !!outing.pet,
          fed: !!outing.fed,
          leftAt: outing.leftAt,
          returnedAt: now
        }
      })
      try {
        await writeVisitLog(openid, {
          direction: 'outbound',
          cardId: outing.cardId || '',
          breed: (displayCard && displayCard.breed) || '小猫',
          name: (displayCard && displayCard.name) || '',
          cutoutPath: (displayCard && (displayCard.cutoutPath || displayCard.cutoutFileId)) || '',
          behaviorText: outing.behaviorText || '',
          distanceKm: outing.distanceKm || 0,
          pet: !!outing.pet,
          fed: !!outing.fed,
          leftAt: outing.leftAt,
          leaveAt: now,
          at: now
        })
      } catch (e) {
        console.warn('write outbound visitLog fail', e)
      }
      outing.status = 'home'
      outing.homeSince = now
      outing.homeDuration = randBetweenHours(6, 12)
      outing.visitId = ''
      dirty = true
    }
  }

  if (dirty) {
    user.outing = outing
    await saveUser(user)
    user = await ensureUser(openid)
  }

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

async function interactVisitor(openid, { visitId, action }) {
  const user = await ensureUser(openid)
  const res = await db.collection('visits').doc(visitId).get()
  const visit = res.data
  if (!visit || visit.hostOpenId !== openid || visit.status !== 'active') {
    return { error: 'visitor gone', code: 'GONE' }
  }
  if (action === 'pet') {
    if (!visit.petByHost) await db.collection('visits').doc(visitId).update({ data: { petByHost: true } })
  } else if (action === 'feed') {
    if (visit.fedByHost) return { toast: '' }
    const day = todayKey()
    if (user.fedDate === day) return { error: '今日已送过猫粮', code: 'FED_LIMIT' }
    await db.collection('visits').doc(visitId).update({ data: { fedByHost: true } })
    await db.collection('users').doc(user._id).update({ data: { fedDate: day } })
  }
  if (visit.ownerOpenId) {
    const owners = await db.collection('users').where({ _openid: visit.ownerOpenId }).limit(1).get()
    const owner = owners.data && owners.data[0]
    if (owner && owner.outing && owner.outing.visitId === visitId) {
      const outing = owner.outing
      if (action === 'pet') outing.pet = true
      if (action === 'feed') outing.fed = true
      await db.collection('users').doc(owner._id).update({ data: { outing } })
    }
  }
  return { toast: action === 'pet' ? '你摸了摸它' : '你给了它一颗猫粮' }
}

async function dismissReport(openid, { auto }) {
  const user = await ensureUser(openid)
  const outing = user.outing || defaultOuting()
  outing.unreadReport = null
  if (auto) outing.lastAutoReportDay = todayKey()
  await db.collection('users').doc(user._id).update({ data: { outing } })
  return { ok: true }
}

async function dismissLeftTrace(openid, { visitId }) {
  if (!visitId) return { error: '缺少 visitId', code: 'BAD_REQUEST' }
  // 只能关闭自己小屋（host）的来访痕迹
  const res = await db
    .collection('visits')
    .where({ _id: visitId, hostOpenId: openid })
    .update({ data: { seenLeft: true } })
  if (!res || !res.stats || !res.stats.updated) return { error: 'visit not found', code: 'NOT_FOUND' }
  return { ok: true }
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
        ? `你的${l.name || l.breed || '小猫'}去串门了`
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
