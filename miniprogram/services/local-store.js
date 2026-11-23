/**
 * 本地存储实现：云开发未开通或调用失败时使用，保证开发期可完整走通闭环。
 * 数据结构与云库集合对齐，含 duels / recordStats / 猫猫出门 预留。
 */
const { WHITELIST, CAT_BREEDS, UNKNOWN_LABEL, CONFIDENCE_THRESHOLD } = require('../constants/breeds')
const { clampText, cardDisplayName } = require('../utils/format')
const outingEngine = require('./outing-engine')
const careEngine = require('./care-engine')
const { normalizeMateIds, roomOccupancy, ROOM_CAPACITY } = require('../utils/room-mates')
const { defaultLayout, serializeLayout } = require('../constants/furniture')
const { isEphemeralPath } = require('../utils/card-media')
const {
  normalizeRecognizedBreed,
  ensureRecognizedBreedField
} = require('../utils/breed-review')
const { formatDistanceLabel, randomDistanceKm, pickBehavior, DURATIONS, randBetween, HOUR_MS } = require('../constants/outing')
const { normalizePhotoIdentity, appendIdentity } = require('../utils/photo-identity')
const { ENCOUNTER_INTIMACY, encounterCountOf } = require('../utils/encounters')
const STORE_KEY = 'mxh_local_db_v1'

/** 内存缓存：同一会话避免每次进页都同步读整库 */
let memDb = null

function uid(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function emptyDb() {
  return {
    users: {},
    cards: [],
    memories: [],
    duels: [],
    visits: [],
    outingLogs: [],
    visitLogs: [],
    released: [],
    breedReviews: []
  }
}

function load() {
  if (memDb) return memDb
  try {
    const raw = wx.getStorageSync(STORE_KEY)
    if (raw && typeof raw === 'object') {
      memDb = {
        users: raw.users || {},
        cards: raw.cards || [],
        memories: raw.memories || [],
        duels: raw.duels || [],
        visits: raw.visits || [],
        outingLogs: raw.outingLogs || [],
        visitLogs: raw.visitLogs || [],
        released: raw.released || [],
        breedReviews: raw.breedReviews || []
      }
      if (restoreOutingDurations(memDb)) {
        try {
          save(memDb)
        } catch (e) {
          console.warn('[local] save outing durations fail', e)
        }
      }
      return memDb
    }
  } catch (e) {
    /* ignore */
  }
  memDb = emptyDb()
  return memDb
}

// 旧版把一小时存成 30 秒。换算尚未结束的计时，历史记录保留原时间。
function restoreOutingDurations(db) {
  const oldHour = 30 * 1000
  const toRealHours = (duration) => duration * (HOUR_MS / oldHour)
  let changed = false
  Object.values(db.users).forEach((user) => {
    const outing = user.outing
    if (!outing) return
    const phase = outing.status
    const field = { home: 'homeDuration', out: 'travelDuration', visiting: 'visitDuration' }[phase]
    if (field && outing[field] > 0 && outing[field] <= 12 * oldHour) {
      outing[field] = toRealHours(outing[field])
      changed = true
    }
  })
  db.visits.forEach((visit) => {
    const duration = visit.leaveAt - visit.arriveAt
    if (visit.status !== 'active' || duration <= 0 || duration > 12 * oldHour) return
    visit.leaveAt = visit.arriveAt + toRealHours(duration)
    if (visit._mockAutoPetAt > visit.arriveAt) {
      visit._mockAutoPetAt = visit.arriveAt + toRealHours(visit._mockAutoPetAt - visit.arriveAt)
    }
    changed = true
  })
  return changed
}

function ensureVisitLogs(db) {
  if (!Array.isArray(db.visitLogs)) db.visitLogs = []
  return db.visitLogs
}

function pushVisitLog(db, entry) {
  ensureVisitLogs(db)
  db.visitLogs.unshift({
    _id: uid('vlog'),
    createdAt: Date.now(),
    ...entry
  })
  // 控制体量
  if (db.visitLogs.length > 200) db.visitLogs.length = 200
}

function buildInteractLine(pet, fed, adopted) {
  const bits = []
  if (pet) bits.push(outingEngine.COPY.reportPet)
  if (fed) bits.push(outingEngine.COPY.reportFed)
  if (adopted) bits.push('它的卡片被人收下了。')
  return bits.join('')
}

function save(db) {
  memDb = db
  wx.setStorageSync(STORE_KEY, db)
}

function ensureUser(db, openid) {
  if (!db.users[openid]) {
    db.users[openid] = {
      _id: openid,
      _openid: openid,
      nickName: '猫友',
      avatarUrl: '',
      displayCardId: '',
      roomMateIds: [],
      roomBackgroundId: 'default',
      roomFurniture: null,
      care: null,
      stats: { cardCount: 0, breedCount: 0, memoryCount: 0 },
      privacyAgreedAt: 0,
      createdAt: Date.now()
    }
  }
  outingEngine.ensureUserOutingFields(db.users[openid])
  if (!Array.isArray(db.users[openid].roomFurniture)) {
    db.users[openid].roomFurniture = null
  }
  if (!Array.isArray(db.users[openid].roomMateIds)) {
    db.users[openid].roomMateIds = []
  }
  if (!db.users[openid].care) {
    db.users[openid].care = null
  }
  return db.users[openid]
}

function recomputeStats(db, openid) {
  const user = ensureUser(db, openid)
  const cards = db.cards.filter((c) => c._openid === openid)
  const breeds = new Set(cards.map((c) => c.breed))
  const memories = db.memories.filter((m) => m._openid === openid)
  user.stats = {
    cardCount: cards.length,
    breedCount: breeds.size,
    memoryCount: memories.length
  }
  cards.forEach((c) => {
    c.memoryCount = memories.filter((m) => m.cardId === c._id).length
  })
}

function getOpenId() {
  let id = wx.getStorageSync('mxh_local_openid')
  if (!id) {
    id = uid('local')
    wx.setStorageSync('mxh_local_openid', id)
  }
  return id
}

/**
 * 把「挂在别的 openid 下」的本地卡/记忆认领到当前用户。
 * 开发者工具清缓存、本地随机 openid 与云端 openid 切换时，卡其实还在，只是被滤掉了。
 */
function reclaimOrphanData(db, openid) {
  if (!openid) return false
  let changed = false
  const mine = (db.cards || []).filter((c) => c && c._openid === openid)
  if (mine.length > 0) return false

  const orphans = (db.cards || []).filter((c) => c && c._openid && c._openid !== openid)
  if (!orphans.length) return false

  // 优先认领 local_*；否则若当前用户无卡，把全部孤儿一并收回（开发期单用户）
  const byOwner = {}
  orphans.forEach((c) => {
    byOwner[c._openid] = byOwner[c._openid] || []
    byOwner[c._openid].push(c)
  })
  const owners = Object.keys(byOwner)
  const localOwners = owners.filter((o) => String(o).indexOf('local_') === 0)
  const takeOwners = localOwners.length ? localOwners : owners

  if (!takeOwners.length) return false

  const takeSet = {}
  takeOwners.forEach((o) => {
    takeSet[o] = true
  })

  ;(db.cards || []).forEach((c) => {
    if (c && takeSet[c._openid]) {
      c._openid = openid
      changed = true
    }
  })
  ;(db.memories || []).forEach((m) => {
    if (m && takeSet[m._openid]) {
      m._openid = openid
      changed = true
    }
  })
  ;(db.outingLogs || []).forEach((l) => {
    if (l && takeSet[l._openid]) {
      l._openid = openid
      changed = true
    }
  })

  // 合并旧用户资料（展示猫、背景等）
  takeOwners.forEach((oldId) => {
    const oldUser = db.users && db.users[oldId]
    if (!oldUser) return
    const cur = ensureUser(db, openid)
    if (!cur.displayCardId && oldUser.displayCardId) cur.displayCardId = oldUser.displayCardId
    if ((!cur.roomBackgroundId || cur.roomBackgroundId === 'default') && oldUser.roomBackgroundId) {
      cur.roomBackgroundId = oldUser.roomBackgroundId
    }
    if (!cur.roomFurniture && oldUser.roomFurniture) cur.roomFurniture = oldUser.roomFurniture
    if (!cur.care && oldUser.care) cur.care = oldUser.care
    if (oldUser.nickName && cur.nickName === '猫友') cur.nickName = oldUser.nickName
    changed = true
  })

  return changed
}

/** 云登录成功后：本地身份对齐云端 openid，并收回孤儿卡 */
function bindCloudOpenId(cloudOpenId) {
  if (!cloudOpenId) return { openid: getOpenId(), rebound: 0 }
  const db = load()
  const prev = wx.getStorageSync('mxh_local_openid') || ''
  wx.setStorageSync('mxh_local_openid', cloudOpenId)

  let rebound = 0
  if (prev && prev !== cloudOpenId) {
    ;(db.cards || []).forEach((c) => {
      if (c && c._openid === prev) {
        c._openid = cloudOpenId
        rebound += 1
      }
    })
    ;(db.memories || []).forEach((m) => {
      if (m && m._openid === prev) m._openid = cloudOpenId
    })
    ;(db.outingLogs || []).forEach((l) => {
      if (l && l._openid === prev) l._openid = cloudOpenId
    })
    ;(db.breedReviews || []).forEach((r) => {
      if (r && r._openid === prev) r._openid = cloudOpenId
    })
    ;(db.visitLogs || []).forEach((l) => {
      if (l && l._openid === prev) l._openid = cloudOpenId
    })
    ;(db.released || []).forEach((r) => {
      if (r && (r._openid === prev || r.releasedBy === prev)) {
        r._openid = cloudOpenId
        r.releasedBy = cloudOpenId
      }
    })
    if (db.users && db.users[prev]) {
      const oldUser = db.users[prev]
      const cur = ensureUser(db, cloudOpenId)
      ;[
        'displayCardId',
        'roomMateIds',
        'roomBackgroundId',
        'roomFurniture',
        'care',
        'nickName',
        'avatarUrl',
        'settings',
        'outing',
        'fuzzyGeo'
      ].forEach(
        (k) => {
          if (oldUser[k] != null && (cur[k] == null || cur[k] === '' || cur[k] === 'default')) {
            cur[k] = oldUser[k]
          }
        }
      )
      // 保留旧 user 以防其它引用，但主身份已切到云 openid
    }
  }

  const reclaimed = reclaimOrphanData(db, cloudOpenId)
  ensureUser(db, cloudOpenId)
  recomputeStats(db, cloudOpenId)
  if (prev !== cloudOpenId || rebound || reclaimed) save(db)
  return { openid: cloudOpenId, rebound, reclaimed: !!reclaimed }
}

async function login() {
  const db = load()
  const openid = getOpenId()
  const existed = !!db.users[openid]
  const reclaimed = reclaimOrphanData(db, openid)
  const user = ensureUser(db, openid)
  const before = JSON.stringify(user.stats || null)
  recomputeStats(db, openid)
  // 新用户、认领孤儿卡、或统计变化时落盘
  if (!existed || reclaimed || before !== JSON.stringify(user.stats || null)) save(db)
  return { openid, user }
}

async function getProfile() {
  const db = load()
  const openid = getOpenId()
  const user = ensureUser(db, openid)
  const before = JSON.stringify(user.stats || null)
  recomputeStats(db, openid)
  if (before !== JSON.stringify(user.stats || null)) save(db)
  return { user }
}

function resetHomeOuting(user, cardId) {
  if (outingEngine.isAway(user.outing)) return
  Object.assign(user.outing, {
    status: cardId ? 'home' : 'idle',
    cardId,
    homeSince: cardId ? Date.now() : 0,
    homeDuration: cardId ? randBetween(DURATIONS.homeMin, DURATIONS.homeMax) : 0
  })
}

/** 放入小屋：最多 3 只，地位相同；满员抛 ROOM_FULL */
async function addCardToRoom(cardId) {
  const db = load()
  const openid = getOpenId()
  const user = ensureUser(db, openid)
  if (!cardId) throw new Error('找不到这只猫')
  // 只校验 id：云端卡可能刚镜像，或仅用于小屋位（图由列表/详情补）
  let card = db.cards.find((c) => c._id === cardId)
  if (!card) {
    // 宽松：允许先占位，避免云端卡未落本地时误报
    card = { _id: cardId }
  }

  const occ = roomOccupancy(user)
  if (occ.isInRoom(cardId)) {
    return { user, already: true, toast: '已经在小屋里了', occupancy: occ }
  }
  if (occ.full) {
    const err = new Error(`小屋已满（${ROOM_CAPACITY}只），请先移出一只`)
    err.code = 'ROOM_FULL'
    err.occupancy = occ
    throw err
  }

  if (!user.displayCardId) {
    user.displayCardId = cardId
    resetHomeOuting(user, cardId)
    user.roomMateIds = normalizeMateIds(user.roomMateIds, cardId)
  } else {
    user.roomMateIds = normalizeMateIds([...(user.roomMateIds || []), cardId], user.displayCardId)
  }
  save(db)
  return {
    user,
    toast: '已放入小屋',
    occupancy: roomOccupancy(user)
  }
}

/** 移出小屋；若移出焦点猫则列表下一只顶上（仅内部同步，无角色差异） */
async function removeCardFromRoom(cardId) {
  const db = load()
  const openid = getOpenId()
  const user = ensureUser(db, openid)
  if (!cardId) throw new Error('找不到这只猫')
  const occ = roomOccupancy(user)
  if (!occ.isInRoom(cardId)) {
    return { user, already: true, toast: '不在小屋里', occupancy: occ }
  }

  if (user.displayCardId === cardId) {
    const rest = normalizeMateIds(user.roomMateIds, '')
    if (rest.length) {
      user.displayCardId = rest[0]
      user.roomMateIds = rest.slice(1)
    } else {
      user.displayCardId = ''
      user.roomMateIds = []
    }
    resetHomeOuting(user, user.displayCardId)
  } else {
    user.roomMateIds = normalizeMateIds(
      (user.roomMateIds || []).filter((id) => id !== cardId),
      user.displayCardId
    )
  }
  save(db)
  return { user, toast: '已移出小屋', occupancy: roomOccupancy(user) }
}

/** 切换护理/出门焦点猫（UI 不展示角色，仅内部对齐 care / outing） */
async function setRoomMain(cardId) {
  const db = load()
  const openid = getOpenId()
  const user = ensureUser(db, openid)
  if (!cardId) throw new Error('找不到这只猫')

  const prev = user.displayCardId || ''
  if (prev === cardId) {
    return { user, toast: '', occupancy: roomOccupancy(user) }
  }

  let mates = normalizeMateIds(user.roomMateIds, '')
  mates = mates.filter((id) => id !== cardId)
  if (prev) mates.unshift(prev)
  mates = mates.slice(0, ROOM_CAPACITY - 1)

  user.displayCardId = cardId
  user.roomMateIds = normalizeMateIds(mates, cardId)
  resetHomeOuting(user, cardId)
  save(db)
  return { user, toast: '', occupancy: roomOccupancy(user) }
}

async function updateProfile(payload) {
  const db = load()
  const openid = getOpenId()
  const user = ensureUser(db, openid)
  if (payload.nickName !== undefined) user.nickName = payload.nickName
  if (payload.avatarUrl !== undefined) user.avatarUrl = payload.avatarUrl
  if (payload.displayCardId !== undefined) {
    const prev = user.displayCardId
    user.displayCardId = payload.displayCardId || ''
    if (user.displayCardId !== prev) {
      resetHomeOuting(user, user.displayCardId)
      // 从同住里拿掉，避免重复
      user.roomMateIds = normalizeMateIds(user.roomMateIds, user.displayCardId)
    }
  }
  if (payload.roomMateIds !== undefined) {
    user.roomMateIds = normalizeMateIds(payload.roomMateIds, user.displayCardId)
  }
  if (payload.roomBackgroundId !== undefined) user.roomBackgroundId = payload.roomBackgroundId
  if (payload.roomFurniture !== undefined) {
    user.roomFurniture = serializeLayout(payload.roomFurniture)
  }
  if (payload.care !== undefined) {
    user.care = careEngine.normalizeCare(payload.care)
  }
  if (payload.privacyAgreedAt !== undefined) user.privacyAgreedAt = payload.privacyAgreedAt
  if (payload.settings) {
    user.settings = Object.assign({}, user.settings, payload.settings)
  }
  if (payload.fuzzyGeo !== undefined) user.fuzzyGeo = payload.fuzzyGeo
  save(db)
  return { user }
}

function syncVisitInteractionsToOwner(db, visit) {
  if (!visit || !visit.ownerOpenId) return
  const owner = db.users[visit.ownerOpenId]
  if (!owner) return
  outingEngine.applyOwnerInteractionFromVisit(owner, visit)
}

function recordInboundVisitLog(db, visit) {
  if (!visit || !visit.hostOpenId) return
  if (visit._loggedInbound) return
  visit._loggedInbound = true
  pushVisitLog(db, {
    _openid: visit.hostOpenId,
    direction: 'inbound',
    visitId: visit._id,
    breed: visit.breed || '小猫',
    name: visit.name || '',
    cutoutPath: visit.cutoutPath || '',
    behaviorText: visit.behaviorText || '',
    ...(Number.isInteger(visit.behaviorIndex) ? { behaviorIndex: visit.behaviorIndex } : {}),
    ...(visit.friend ? { friend: visit.friend } : {}),
    distanceKm: visit.distanceKm || 0,
    fromReleased: !!visit.fromReleased,
    pet: !!visit.petByHost,
    fed: !!visit.fedByHost,
    adopted: !!visit.adoptedByHost,
    arriveAt: visit.arriveAt || 0,
    leaveAt: visit.leaveAt || Date.now(),
    at: visit.leaveAt || Date.now()
  })
}

function expireVisits(db, now) {
  db.visits.forEach((v) => {
    if (v.status === 'active' && now >= v.leaveAt) {
      v.status = 'left'
      syncVisitInteractionsToOwner(db, v)
      recordInboundVisitLog(db, v)
      // 放生猫串门结束：若未被收养，回到流浪
      if (v.releasedId && Array.isArray(db.released)) {
        const rel = db.released.find((r) => r._id === v.releasedId)
        if (rel && rel.status === 'visiting') {
          rel.status = 'wandering'
        }
      }
    }
  })
}

function enrichReleasedStatus(db, item) {
  if (!item) return item
  if (item.status === 'adopted') {
    return {
      ...item,
      status: 'adopted',
      statusLabel: '卡片已被收下',
      statusTone: 'adopted'
    }
  }
  const visiting = (db.visits || []).some(
    (v) => v.status === 'active' && (v.releasedId === item._id || v.guestCardId === item.cardId)
  )
  if (visiting || item.status === 'visiting') {
    return {
      ...item,
      status: 'visiting',
      statusLabel: '正在别人家串门',
      statusTone: 'visiting'
    }
  }
  return {
    ...item,
    status: 'wandering',
    statusLabel: '流浪中',
    statusTone: 'wandering'
  }
}

/** 本地单用户：把外出猫投放到「模拟邻居屋」，并偶尔生成访客猫 */
function createVisitToHostLocal(db, ownerOpenId, payload) {
  const hostKey = `mock_host_${uid('h')}`
  const visit = {
    _id: uid('visit'),
    hostKey,
    hostOpenId: hostKey,
    ownerOpenId,
    guestCardId: payload.guestCard._id,
    breed: payload.guestCard.breed,
    cutoutPath: payload.guestCard.cutoutPath || payload.guestCard.originalPath || '',
    behaviorText: payload.behaviorText,
    behaviorIndex: payload.behaviorIndex,
    distanceKm: payload.distanceKm,
    arriveAt: payload.arriveAt,
    leaveAt: payload.leaveAt,
    status: 'active',
    petByHost: false,
    fedByHost: false,
    seenLeft: false,
    // 模拟邻居有概率互动
    _mockAutoPetAt: payload.arriveAt + Math.floor((payload.leaveAt - payload.arriveAt) * (0.3 + Math.random() * 0.4)),
    _mockWillPet: Math.random() < 0.55,
    _mockWillFed: Math.random() < 0.35,
    friend: Math.random() < 0.3
      ? { name: '麦团', image: '/assets/illus/map-cat-2.png', kind: 'illustration' }
      : null
  }
  db.visits.push(visit)
  return visit
}

function applyMockHostInteractions(db, now) {
  db.visits.forEach((v) => {
    if (v.status !== 'active') return
    if (!String(v.hostOpenId || '').startsWith('mock_host_')) return
    if (v._mockWillPet && !v.petByHost && now >= v._mockAutoPetAt) {
      v.petByHost = true
      syncVisitInteractionsToOwner(db, v)
    }
    if (v._mockWillFed && !v.fedByHost && now >= v._mockAutoPetAt + 5000) {
      v.fedByHost = true
      syncVisitInteractionsToOwner(db, v)
    }
  })
}

function pickReleasedGuest(db, hostOpenId) {
  const pool = (db.released || []).filter(
    (r) => r && r.status !== 'adopted' && r.status !== 'visiting'
  )
  if (!pool.length) return null
  // 优先别人放生的；没有则也可能是自己放生的猫回来串门
  const others = pool.filter((r) => r.releasedBy !== hostOpenId)
  const candidates = others.length ? others : pool
  return candidates[Math.floor(Math.random() * candidates.length)] || null
}

function maybeSpawnMockVisitor(db, openid, now) {
  const user = ensureUser(db, openid)
  if (!user.settings.allowVisitors) return
  const hasActive = db.visits.some((v) => v.hostOpenId === openid && v.status === 'active')
  if (hasActive) return
  const recentLeft = db.visits.some(
    (v) => v.hostOpenId === openid && v.status === 'left' && !v.seenLeft && now - v.leaveAt < 24 * HOUR_LIKE()
  )
  if (recentLeft) return
  // 约 25% 概率在打开小屋时生成一只访客（优先放生池）
  const lastSpawn = user._lastMockVisitorAt || 0
  if (now - lastSpawn < 3 * HOUR_LIKE()) return
  if (Math.random() > 0.25) return

  const released = pickReleasedGuest(db, openid)
  const picked = pickBehavior(-1)
  const distanceKm = randomDistanceKm()
  const visitDuration = randBetween(DURATIONS.visitMin, DURATIONS.visitMax)
  let breed = WHITELIST[Math.floor(Math.random() * Math.min(8, WHITELIST.length))]
  let cutoutPath = ''
  let guestCardId = ''
  let ownerOpenId = 'mock_owner'
  let behaviorText = picked.text
  let fromReleased = false

  let releasedId = ''
  if (released && released.status !== 'adopted') {
    breed = released.breed || breed
    cutoutPath = released.cutoutFileId || released.cutoutPath || released.originalPath || ''
    guestCardId = released.cardId || released._id || ''
    ownerOpenId = released.releasedBy || 'released'
    fromReleased = true
    releasedId = released._id
    behaviorText =
      released.releasedBy === openid
        ? '它在门口停了一会儿，好像认出了这里。'
        : released.name
          ? `流浪的「${released.name}」来串门了。`
          : '一张流浪的猫卡路过你家，停了下来。'
    released.visitCount = (released.visitCount || 0) + 1
    released.lastVisitAt = now
    released.status = 'visiting'
  }

  db.visits.push({
    _id: uid('visit'),
    hostKey: openid,
    hostOpenId: openid,
    ownerOpenId,
    guestCardId,
    breed,
    cutoutPath,
    behaviorText,
    distanceKm,
    arriveAt: now,
    leaveAt: now + visitDuration,
    status: 'active',
    petByHost: false,
    fedByHost: false,
    seenLeft: false,
    fromReleased,
    releasedId
  })
  user._lastMockVisitorAt = now
}

/** 放生：离开图鉴，进入流浪池，以后可能去别人家串门 */
async function releaseCard(cardId, cloudRelease, cloudRoom) {
  const db = load()
  const openid = getOpenId()
  const user = ensureUser(db, openid)
  const idx = db.cards.findIndex((c) => c._id === cardId && c._openid === openid)
  const card = db.cards[idx]
  if (!cloudRelease) {
    if (!card) throw new Error('找不到这只猫')
    if (outingEngine.isAway(user.outing) && user.outing.cardId === cardId) {
      const err = new Error('这只猫还在外面，回来后才能送去流浪')
      err.code = 'CAT_AWAY'
      throw err
    }
  }

  if (idx >= 0) db.cards.splice(idx, 1)
  if (!Array.isArray(db.released)) db.released = []
  if (!db.released.some((item) => item.cardId === cardId && item.releasedBy === openid)) {
    db.released.unshift(cloudRelease || {
      _id: uid('rel'),
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
      status: 'wandering'
    })
  }

  user.roomMateIds = normalizeMateIds(
    (user.roomMateIds || []).filter((id) => id !== cardId),
    user.displayCardId === cardId ? '' : user.displayCardId
  )
  if (user.displayCardId === cardId) {
    const promote = (user.roomMateIds || [])[0]
    const next =
      (promote && db.cards.find((c) => c._id === promote)) ||
      db.cards.find((c) => c._openid === openid)
    user.displayCardId = next ? next._id : ''
    user.roomMateIds = normalizeMateIds(user.roomMateIds, user.displayCardId)
    resetHomeOuting(user, user.displayCardId)
  }
  if (cloudRoom && !String(user.displayCardId || '').startsWith('card_')) {
    user.displayCardId = cloudRoom.displayCardId
    user.roomMateIds = normalizeMateIds(
      [...cloudRoom.roomMateIds, ...user.roomMateIds.filter((id) => id.startsWith('card_'))],
      user.displayCardId
    )
  }
  if (cloudRelease && user.outing.cardId === cardId) {
    user.outing.status = 'idle'
    resetHomeOuting(user, user.displayCardId)
  }

  // 记忆保留在库里，图鉴不再展示这只猫
  recomputeStats(db, openid)
  save(db)
  return {
    ok: true,
    toast: '它自由了。以后也许会去别人家串门。',
    user
  }
}

async function listMyReleased() {
  const db = load()
  const openid = getOpenId()
  expireVisits(db, Date.now())
  const list = (db.released || [])
    .filter((r) => r && r.releasedBy === openid)
    .sort((a, b) => (b.releasedAt || 0) - (a.releasedAt || 0))
    .map((r) => enrichReleasedStatus(db, r))
  save(db)
  return { list }
}

/** 收养来串门的放生猫：进入自己图鉴，原主人那边显示「已被收养」 */
async function adoptVisitor({ visitId, geo, placeText } = {}) {
  const db = load()
  const openid = getOpenId()
  ensureUser(db, openid)
  const visit = db.visits.find((v) => v._id === visitId && v.hostOpenId === openid)
  if (!visit || visit.status !== 'active' || Date.now() >= visit.leaveAt) throw new Error('小猫已经走了')
  if (!visit.fromReleased || !visit.releasedId) throw new Error('这只不是流浪的卡片')

  const released = (db.released || []).find((r) => r._id === visit.releasedId)
  if (!released) throw new Error('找不到这张流浪卡片')
  if (released.status === 'adopted') throw new Error('它的卡片已经被别人收下了')

  const nextGeo =
    geo &&
    typeof geo.lat === 'number' &&
    typeof geo.lng === 'number' &&
    Number.isFinite(geo.lat) &&
    Number.isFinite(geo.lng)
      ? { lat: geo.lat, lng: geo.lng }
      : null

  const card = {
    _id: uid('card'),
    _openid: openid,
    cutoutPath: released.cutoutPath || visit.cutoutPath || '',
    originalPath: released.originalPath || '',
    cutoutFileId: released.cutoutFileId || '',
    originalFileId: released.originalFileId || '',
    breed: released.breed || visit.breed || '待识别',
    name: clampText(released.name || '', 12),
    confidence: 100,
    shotAt: Date.now(),
    note: '在门口收下的流浪卡片',
    placeText: clampText(placeText || '我家门口', 30),
    geo: nextGeo,
    mattingFailed: !released.cutoutPath && !released.cutoutFileId,
    memoryCount: 0,
    intimacy: 18,
    intimacyDay: '',
    intimacyGainedToday: 0,
    recordStats: { duelWins: 0, duelLosses: 0, lastDuelAt: 0 },
    createdAt: Date.now(),
    adoptedFromReleasedId: released._id
  }
  db.cards.unshift(card)

  released.status = 'adopted'
  released.adoptedBy = openid
  released.adoptedAt = Date.now()
  released.adoptedCardId = card._id

  visit.status = 'left'
  visit.seenLeft = true
  visit.adoptedByHost = true
  recordInboundVisitLog(db, visit)

  recomputeStats(db, openid)
  save(db)
  return {
    card,
    toast: '你收下了它的卡片',
    released
  }
}

function backfillVisitLogsFromLegacy(db, openid) {
  ensureVisitLogs(db)
  if (db.visitLogs.some((l) => l && l._openid === openid)) return
  // 首次打开：从旧 outingLogs / visits 回填
  ;(db.outingLogs || []).forEach((l) => {
    if (!l || l._openid !== openid) return
    const card = l.cardId ? db.cards.find((c) => c._id === l.cardId) : null
    pushVisitLog(db, {
      _openid: openid,
      direction: 'outbound',
      cardId: l.cardId || '',
      breed: (card && card.breed) || '小猫',
      name: (card && card.name) || '',
      cutoutPath: (card && (card.cutoutPath || card.cutoutFileId)) || '',
      behaviorText: l.behaviorText || '',
      distanceKm: l.distanceKm || 0,
      pet: !!l.pet,
      fed: !!l.fed,
      leftAt: l.leftAt,
      leaveAt: l.returnedAt,
      at: l.returnedAt || l.leftAt || Date.now(),
      legacy: true
    })
  })
  ;(db.visits || []).forEach((v) => {
    if (!v || v.hostOpenId !== openid || v.status !== 'left') return
    recordInboundVisitLog(db, v)
  })
}

async function listVisitLogs({ direction } = {}) {
  const db = load()
  const openid = getOpenId()
  ensureUser(db, openid)
  expireVisits(db, Date.now())
  backfillVisitLogsFromLegacy(db, openid)
  // 补记尚未落账的来访（dismiss 前就 left 的）
  ;(db.visits || []).forEach((v) => {
    if (v.hostOpenId === openid && v.status === 'left' && !v._loggedInbound) {
      recordInboundVisitLog(db, v)
    }
  })
  save(db)

  const showDistance = (db.users[openid].settings || {}).showDistance !== false
  let list = ensureVisitLogs(db).filter((l) => l && l._openid === openid)
  if (direction === 'inbound' || direction === 'outbound') {
    list = list.filter((l) => l.direction === direction)
  }
  list = list
    .slice()
    .sort((a, b) => (b.at || b.leaveAt || b.createdAt || 0) - (a.at || a.leaveAt || a.createdAt || 0))
    .slice(0, 100)
    .map((l) => {
      const distanceLabel = formatDistanceLabel(l.distanceKm, showDistance)
      const interactLine = buildInteractLine(l.pet, l.fed, l.adopted)
      const title =
        l.direction === 'outbound'
          ? `你的${l.name || (['待识别', '识别中…', '未知小动物'].indexOf(l.breed) >= 0 ? '' : l.breed) || '小猫'}去串门了`
          : `${l.fromReleased ? '流浪的' : ''}${l.name || l.breed || '小猫'}来过`
      const summary =
        l.direction === 'outbound'
          ? `去了「${distanceLabel}」`
          : `来自「${distanceLabel}」`
      return {
        ...l,
        distanceLabel,
        interactLine,
        title,
        summary,
        directionLabel: l.direction === 'outbound' ? '去串门' : '来串门'
      }
    })
  return { logs: list }
}

function HOUR_LIKE() {
  const { HOUR_MS } = require('../constants/outing')
  return HOUR_MS
}

function visitSig(db, openid) {
  return db.visits
    .filter((v) => v.hostOpenId === openid)
    .map((v) => `${v._id}:${v.status}:${v.petByHost ? 1 : 0}:${v.fedByHost ? 1 : 0}:${v.seenLeft ? 1 : 0}`)
    .join('|')
}

function runOutingTick(db, openid, now = Date.now(), { mockVisitors = true } = {}) {
  const user = ensureUser(db, openid)
  const beforeOuting = JSON.stringify(user.outing || null)
  const beforeVisits = visitSig(db, openid)
  const beforeLogs = db.outingLogs.length
  const beforeSpawn = user._lastMockVisitorAt || 0

  applyMockHostInteractions(db, now)
  expireVisits(db, now)

  const displayCard = user.displayCardId
    ? db.cards.find((c) => c._id === user.displayCardId && c._openid === openid)
    : null

  const tick = outingEngine.tickOwnerOuting({
    user,
    now,
    getDisplayCard: () => displayCard || null,
    getOutingCard: (id) => db.cards.find((card) => card._id === id && card._openid === openid),
    createVisitToHost: (payload) => createVisitToHostLocal(db, openid, payload),
    getVisit: (id) => id && db.visits.find((visit) => visit._id === id && visit.ownerOpenId === openid),
    onReturnHome: (log) => {
      db.outingLogs.unshift({
        _id: uid('olog'),
        _openid: openid,
        ...log
      })
      // 小屋串门总账：我去串门
      const guestCard =
        (log.cardId && db.cards.find((c) => c._id === log.cardId)) || displayCard || null
      pushVisitLog(db, {
        _openid: openid,
        direction: 'outbound',
        ...log,
        breed: (guestCard && guestCard.breed) || '小猫',
        name: (guestCard && guestCard.name) || '',
        cutoutPath: log.catImage,
        leaveAt: log.returnedAt,
        at: log.returnedAt || now
      })
      // 出门回来补一点状态
      user.care = careEngine.applyHomecomingBonus(user.care || careEngine.DEFAULT_CARE, now)
      // 同步结束对应 visit
      const visit = db.visits.find((v) => v._id === user.outing.visitId)
      if (visit && visit.status === 'active') {
        visit.status = 'left'
        syncVisitInteractionsToOwner(db, visit)
      }
    }
  })

  if (mockVisitors) maybeSpawnMockVisitor(db, openid, now)
  expireVisits(db, now)

  const dirty =
    !!(tick && tick.changed) ||
    beforeOuting !== JSON.stringify(user.outing || null) ||
    beforeVisits !== visitSig(db, openid) ||
    beforeLogs !== db.outingLogs.length ||
    beforeSpawn !== (user._lastMockVisitorAt || 0)

  return dirty
}

async function getRoomState({ cloudMode = false } = {}) {
  const db = load()
  const openid = getOpenId()
  const user = ensureUser(db, openid)
  const now = Date.now()
  const trackedId = outingEngine.isAway(user.outing) ? user.outing.cardId : user.displayCardId
  const advanceOuting = !cloudMode || String(trackedId || '').startsWith('card_')
  const dirtyOuting = advanceOuting && runOutingTick(db, openid, now, { mockVisitors: !cloudMode })

  // 弱状态离线衰减
  const prevCare = JSON.stringify(user.care || null)
  user.care = careEngine.applyDecay(user.care || careEngine.DEFAULT_CARE, now)
  if (!user.roomFurniture) user.roomFurniture = defaultLayout()

  const dirty = dirtyOuting || prevCare !== JSON.stringify(user.care || null)
  if (dirty) save(db)

  const showDistance = user.settings.showDistance !== false
  const displayCard = user.displayCardId
    ? db.cards.find((c) => c._id === user.displayCardId)
    : null

  const outing = user.outing || {}
  const outingActive = outing.status === 'out' || outing.status === 'visiting'
  const outingCardId = outingActive
    ? outing.cardId || user.displayCardId || ''
    : ''
  const outingCard = outingCardId
    ? db.cards.find((c) => c._id === outingCardId)
    : null
  const myCatStatus = !displayCard && !outingCardId
    ? 'none'
    : outingActive
      ? 'away'
      : displayCard
        ? 'home'
        : 'none'

  const outingPhase =
    outingActive
      ? outing.status === 'visiting'
        ? 'visiting'
        : 'out'
      : myCatStatus === 'home'
        ? 'home'
        : 'none'

  const activeVisitor = !cloudMode && db.visits.find((v) => v.hostOpenId === openid && v.status === 'active')
  const leftVisitor = !cloudMode && !activeVisitor
    ? db.visits
        .filter((v) => v.hostOpenId === openid && v.status === 'left' && !v.seenLeft)
        .sort((a, b) => b.leaveAt - a.leaveAt)[0]
    : null

  const unreadReport = outing.unreadReport || null
  const autoShowReport = outingEngine.shouldAutoShowReport(user, now)

  return {
    user,
    displayCard: displayCard || null,
    myCatStatus,
    outingPhase,
    outingCardId,
    outingCatName: outingCard ? cardDisplayName(outingCard) : '',
    care: user.care,
    careBars: careEngine.toBars(user.care),
    furniture: user.roomFurniture,
    unreadBadge: unreadReport ? 1 : 0,
    unreadReport,
    autoShowReport,
    visitor: activeVisitor
      ? {
          id: activeVisitor._id,
          source: 'local',
          breed: activeVisitor.breed,
          cutoutPath: activeVisitor.cutoutPath,
          behaviorText: activeVisitor.behaviorText,
          distanceLabel: formatDistanceLabel(activeVisitor.distanceKm, showDistance),
          petByHost: !!activeVisitor.petByHost,
          fedByHost: !!activeVisitor.fedByHost,
          fromReleased: !!activeVisitor.fromReleased,
          releasedId: activeVisitor.releasedId || '',
          canAdopt: !!activeVisitor.fromReleased && !activeVisitor.adoptedByHost
        }
      : null,
    leftTrace: leftVisitor
      ? {
          id: leftVisitor._id,
          breed: leftVisitor.breed,
          behaviorText: leftVisitor.behaviorText,
          distanceLabel: formatDistanceLabel(leftVisitor.distanceKm, showDistance)
        }
      : null
  }
}

/** 对本猫互动：摸头 / 喂食 / 玩耍 / 哄睡；同步涨该猫亲密度 */
async function careCat({ action, cardId, useCloudOuting }) {
  const db = load()
  const openid = getOpenId()
  const user = ensureUser(db, openid)
  const now = Date.now()
  const outing = user.outing || {}
  const outingActive = outing.status === 'out' || outing.status === 'visiting'
  const outingCardId = outingActive ? outing.cardId || user.displayCardId || '' : ''
  const occ = roomOccupancy(user)
  const targetId = cardId && occ.isInRoom(cardId) ? cardId : user.displayCardId
  if (!targetId) {
    const err = new Error('小屋里还没有猫')
    err.code = 'NO_DISPLAY'
    throw err
  }
  if (outingCardId && targetId === outingCardId && (!useCloudOuting || targetId.startsWith('card_'))) {
    const err = new Error('它还在外面呢')
    err.code = 'CAT_AWAY'
    throw err
  }
  // 互动哪只就切焦点到哪只；外出中不改 outing，避免把出门状态冲掉
  if (targetId !== user.displayCardId) {
    let mates = normalizeMateIds(user.roomMateIds, '')
    mates = mates.filter((id) => id !== targetId)
    if (user.displayCardId) mates.unshift(user.displayCardId)
    user.displayCardId = targetId
    user.roomMateIds = normalizeMateIds(mates, targetId)
    resetHomeOuting(user, targetId)
  }
  const { care, toast } = careEngine.applyAction(user.care || careEngine.DEFAULT_CARE, action, now)
  user.care = care

  const card = db.cards.find((c) => c._id === targetId && c._openid === openid)
  let intimacyView = careEngine.intimacyView(card)
  let intimacyPatch = null
  let intimacyGained = 0
  if (card) {
    const next = careEngine.applyIntimacyGain(card, action, now)
    card.intimacy = next.intimacy
    card.intimacyDay = next.intimacyDay
    card.intimacyGainedToday = next.intimacyGainedToday
    intimacyGained = next.gained
    intimacyView = careEngine.intimacyView(card)
    intimacyPatch = {
      intimacy: next.intimacy,
      intimacyDay: next.intimacyDay,
      intimacyGainedToday: next.intimacyGainedToday
    }
  }

  save(db)
  return {
    care,
    careBars: careEngine.toBars(care),
    toast: intimacyGained > 0 ? `${toast} · 亲密度+${intimacyGained}` : toast,
    cardId: (card && card._id) || targetId || '',
    intimacy: intimacyView,
    intimacyPatch,
    user
  }
}

async function saveRoomFurniture({ furniture }) {
  const db = load()
  const openid = getOpenId()
  const user = ensureUser(db, openid)
  user.roomFurniture = serializeLayout(furniture)
  save(db)
  return { furniture: user.roomFurniture }
}

async function interactVisitor({ visitId, action }) {
  const db = load()
  const openid = getOpenId()
  const user = ensureUser(db, openid)
  const visit = db.visits.find((v) => v._id === visitId && v.hostOpenId === openid)
  if (!visit || visit.status !== 'active' || Date.now() >= visit.leaveAt) throw new Error('小猫已经走了')

  if (action === 'pet') {
    if (visit.petByHost) return { visit, toast: '' }
    visit.petByHost = true
  } else if (action === 'feed') {
    if (visit.fedByHost) return { visit, toast: '' }
    const day = outingEngine.todayKey()
    if (user.fedDate === day) {
      const err = new Error('今日已送过猫粮')
      err.code = 'FED_LIMIT'
      throw err
    }
    visit.fedByHost = true
    user.fedDate = day
  } else {
    throw new Error('bad action')
  }
  syncVisitInteractionsToOwner(db, visit)
  save(db)
  return {
    visit,
    toast: action === 'pet' ? outingEngine.COPY.toastPet : outingEngine.COPY.toastFed
  }
}

async function dismissReport({ auto }) {
  const db = load()
  const openid = getOpenId()
  const user = ensureUser(db, openid)
  outingEngine.markReportShown(user, { auto: !!auto })
  save(db)
  return { ok: true }
}

async function dismissLeftTrace({ visitId }) {
  const db = load()
  const openid = getOpenId()
  const visit = db.visits.find((v) => v._id === visitId && v.hostOpenId === openid)
  if (visit) {
    visit.seenLeft = true
    recordInboundVisitLog(db, visit)
  }
  save(db)
  return { ok: true }
}

async function listOutingLogs({ cardId }) {
  const db = load()
  const openid = getOpenId()
  const user = ensureUser(db, openid)
  const showDistance = user.settings.showDistance !== false
  const list = db.outingLogs
    .filter((l) => l._openid === openid && l.cardId === cardId)
    .sort((a, b) => b.returnedAt - a.returnedAt)
    .map((l) => {
      let interactLine = ''
      if (l.pet) interactLine = outingEngine.COPY.reportPet
      if (l.fed) interactLine = (interactLine ? interactLine : '') + outingEngine.COPY.reportFed
      return {
        ...l,
        distanceLabel: formatDistanceLabel(l.distanceKm, showDistance),
        interactLine
      }
    })
  return { logs: list }
}

/** 开发辅助：立刻推进出门阶段（仅本地） */
async function debugAdvanceOuting() {
  const db = load()
  const openid = getOpenId()
  const user = ensureUser(db, openid)
  const now = Date.now()
  if (user.outing.status === 'home' || user.outing.status === 'idle') {
    if (!user.displayCardId) {
      const first = db.cards.find((c) => c._openid === openid)
      if (first) {
        user.displayCardId = first._id
        user.outing.status = 'home'
        user.outing.cardId = first._id
        user.outing.homeDuration = randBetween(DURATIONS.homeMin, DURATIONS.homeMax)
      }
    }
    user.outing.homeSince = now - (user.outing.homeDuration || randBetween(DURATIONS.homeMin, DURATIONS.homeMax)) - 1000
    // 顺带塞一只模拟访客，方便验收对方视角
    user._lastMockVisitorAt = 0
    const hasActive = db.visits.some((v) => v.hostOpenId === openid && v.status === 'active')
    if (!hasActive && user.settings.allowVisitors) {
      const breed = WHITELIST[Math.floor(Math.random() * Math.min(8, WHITELIST.length))]
      const picked = pickBehavior(-1)
      db.visits.push({
        _id: uid('visit'),
        hostKey: openid,
        hostOpenId: openid,
        ownerOpenId: 'mock_owner',
        guestCardId: '',
        breed,
        cutoutPath: '',
        behaviorText: picked.text,
        distanceKm: randomDistanceKm(),
        arriveAt: now,
        leaveAt: now + randBetween(DURATIONS.visitMin, DURATIONS.visitMax),
        status: 'active',
        petByHost: false,
        fedByHost: false,
        seenLeft: false
      })
    }
  } else if (user.outing.status === 'out') {
    user.outing.leftAt = now - user.outing.travelDuration - 1000
  } else if (user.outing.status === 'visiting') {
    user.outing.visitArriveAt = now - user.outing.visitDuration - 1000
    const visit = db.visits.find((v) => v._id === user.outing.visitId)
    if (visit) visit.leaveAt = now - 1000
  }
  runOutingTick(db, openid, now)
  save(db)
  return getRoomState()
}

function mockBreed() {
  // 本地兜底只随机猫品种，避免把猫 mock 成泰迪等犬种
  const pool = CAT_BREEDS && CAT_BREEDS.length ? CAT_BREEDS : ['中华田园猫']
  const breed = pool[Math.floor(Math.random() * pool.length)] || '中华田园猫'
  const confidence = Math.floor(CONFIDENCE_THRESHOLD + 10 + Math.random() * 18)
  return { breed, confidence }
}

/**
 * 识别 + 抠图白边（拍照 / 上传共用）
 * @param {{ filePath?: string, canvas?: any, skipSticker?: boolean }} payload
 */
async function recognize({ filePath, canvas, skipSticker } = {}) {
  const originalPath = filePath || ''
  const { breed, confidence } = mockBreed()

  if (!originalPath) {
    return {
      ok: false,
      code: 'NO_CAT',
      message: '找不到猫咪',
      breed,
      confidence: 0,
      mattingFailed: true,
      cutoutPath: '',
      originalPath: ''
    }
  }

  // 上层已抠过图时跳过，避免重复洪水填充卡死主线程
  if (skipSticker) {
    return {
      ok: true,
      breed,
      confidence,
      mattingFailed: false,
      cutoutPath: originalPath,
      originalPath,
      mock: true
    }
  }

  const { makeCatSticker } = require('../utils/cat-sticker')
  const sticker = await makeCatSticker(originalPath, { canvas })

  // V1 尚无真实检猫模型：抠图失败不代表没猫，回退原图继续出卡
  if (!sticker.ok) {
    return {
      ok: true,
      breed,
      confidence,
      mattingFailed: true,
      cutoutPath: originalPath,
      originalPath,
      mock: true
    }
  }

  return {
    ok: true,
    breed,
    confidence,
    mattingFailed: false,
    cutoutPath: sticker.cutoutPath,
    originalPath,
    mock: true
  }
}

async function listCards({ limit = 100, breed } = {}) {
  const db = load()
  const openid = getOpenId()
  // 当前身份下没有卡时，尝试收回历史 local_* / 单主孤儿卡
  if (!(db.cards || []).some((c) => c && c._openid === openid)) {
    if (reclaimOrphanData(db, openid)) {
      recomputeStats(db, openid)
      save(db)
    }
  }
  // 清掉已失效的 127.0.0.1/__tmp__ 路径，避免渲染层刷屏
  let mediaDirty = false
  ;(db.cards || []).forEach((c) => {
    if (!c || c._openid !== openid) return
    if (c.cutoutPath && isEphemeralPath(c.cutoutPath)) {
      c.cutoutPath = c.cutoutFileId || ''
      mediaDirty = true
    }
    if (c.originalPath && isEphemeralPath(c.originalPath)) {
      c.originalPath = c.originalFileId || ''
      mediaDirty = true
    }
  })
  // 修复：审核已通过但品种被合并冲回「待识别」
  ;(db.cards || []).forEach((c) => {
    if (!c || c._openid !== openid) return
    const weak =
      !c.breed || c.breed === '待识别' || c.breed === '识别中…' || c.breed === '未知小动物'
    if (!weak) return
    const approved = (db.breedReviews || []).find(
      (r) => r && r.cardId === c._id && r.status === 'approved' && r.toBreed
    )
    if (approved && approved.toBreed) {
      c.breed = approved.toBreed
      c.confidence = c.confidence || 100
      c.pendingBreed = ''
      c.breedReviewStatus = 'approved'
      c.breedReviewId = ''
      mediaDirty = true
    }
  })
  if (mediaDirty) {
    recomputeStats(db, openid)
    save(db)
  }

  let list = db.cards.filter((c) => c._openid === openid)
  if (breed && breed !== '全部') {
    list = list.filter((c) => c.breed === breed)
  }
  list.sort((a, b) => b.shotAt - a.shotAt)
  if (limit) list = list.slice(0, limit)
  // 旧卡补 recognizedBreed
  let dirty = false
  list = list.map((c) => {
    if (c.recognizedBreed !== undefined) return c
    const next = ensureRecognizedBreedField(c)
    if (next.recognizedBreed !== undefined) {
      c.recognizedBreed = next.recognizedBreed
      dirty = true
    }
    return c
  })
  if (dirty) save(db)
  return { cards: list }
}

async function getCard(cardId) {
  const db = load()
  const openid = getOpenId()
  let card = db.cards.find((c) => c._id === cardId)
  if (!card) return { card: null }
  if (card._openid !== openid) {
    card._openid = openid
  }
  if (card.recognizedBreed === undefined) {
    Object.assign(card, ensureRecognizedBreedField(card))
  }
  save(db)
  return { card }
}

async function createCard(payload) {
  const db = load()
  const openid = getOpenId()
  ensureUser(db, openid)
  const recognizedBreed = normalizeRecognizedBreed(
    payload.recognizedBreed !== undefined ? payload.recognizedBreed : payload.breed
  )
  // 品种不再审核：手动选的品种直接生效
  const breed = clampText(payload.breed || '', 20) || UNKNOWN_LABEL
  const pendingBreed = ''
  const breedReviewStatus = ''
  // 定位可选：没有坐标也能保存，之后在足迹页「未标注地点」里补
  const geo =
    payload.geo &&
    typeof payload.geo.lat === 'number' &&
    typeof payload.geo.lng === 'number' &&
    Number.isFinite(payload.geo.lat) &&
    Number.isFinite(payload.geo.lng)
      ? { lat: payload.geo.lat, lng: payload.geo.lng }
      : null
  const card = {
    _id: uid('card'),
    _openid: openid,
    cutoutPath: payload.cutoutPath || '',
    originalPath: payload.originalPath || '',
    photoIdentities: appendIdentity([], normalizePhotoIdentity(payload.photoIdentity)),
    breed,
    recognizedBreed,
    pendingBreed,
    breedReviewStatus,
    name: clampText(payload.name || '', 12),
    confidence: payload.confidence || 0,
    shotAt: payload.shotAt || Date.now(),
    note: clampText(payload.note || '', 100),
    placeText: clampText(payload.placeText || '', 30),
    geo,
    mattingFailed: !!payload.mattingFailed,
    memoryCount: 0,
    intimacy: careEngine.normalizeIntimacy(
      payload.intimacy != null ? payload.intimacy : 8
    ),
    intimacyDay: '',
    intimacyGainedToday: 0,
    recordStats: {
      duelWins: 0,
      duelLosses: 0,
      lastDuelAt: 0
    },
    createdAt: Date.now()
  }
  if (pendingBreed) {
    if (!Array.isArray(db.breedReviews)) db.breedReviews = []
    db.breedReviews.unshift({
      _id: uid('brev'),
      _openid: openid,
      cardId: card._id,
      fromBreed: card.breed,
      toBreed: pendingBreed,
      recognizedBreed,
      status: 'pending',
      createdAt: Date.now()
    })
    card.breedReviewId = db.breedReviews[0]._id
  }
  db.cards.unshift(card)
  recomputeStats(db, openid)
  save(db)
  return { card }
}

/**
 * 本地先建卡（card_*）→ 云端成功后把本地 id 换成云端 _id，并改掉所有引用
 * 返回是否找到并替换
 */
function rekeyCard(oldId, newId) {
  if (!oldId || !newId || oldId === newId) return false
  const db = load()
  const card = db.cards.find((c) => c._id === oldId)
  if (!card) return false
  // 云端 id 已有镜像时，去掉旧的本地卡避免重复
  if (db.cards.some((c) => c._id === newId)) {
    db.cards = db.cards.filter((c) => c._id !== oldId)
  } else {
    card._id = newId
  }
  ;(db.memories || []).forEach((m) => {
    if (m.cardId === oldId) m.cardId = newId
  })
  ;(db.breedReviews || []).forEach((r) => {
    if (r.cardId === oldId) r.cardId = newId
  })
  ;(db.outingLogs || []).forEach((l) => {
    if (l.cardId === oldId) l.cardId = newId
  })
  Object.keys(db.users || {}).forEach((k) => {
    const u = db.users[k]
    if (!u) return
    if (u.displayCardId === oldId) u.displayCardId = newId
    if (Array.isArray(u.roomMateIds)) {
      u.roomMateIds = u.roomMateIds.map((id) => (id === oldId ? newId : id))
    }
    if (u.outing && u.outing.cardId === oldId) u.outing.cardId = newId
  })
  save(db)
  return true
}

/** 本地已放生的卡 id：云端放生失败时，合并列表要过滤掉，避免猫「回来」 */
function releasedCardIds() {
  const db = load()
  return (db.released || []).map((r) => r && r.cardId).filter(Boolean)
}

/** 云端建卡成功后写入本地镜像，避免 getCard 云端读失败时「卡牌不存在」 */
async function mirrorCloudCard(cloudCard, localPaths = {}) {
  if (!cloudCard || !cloudCard._id) return { card: null }
  const db = load()
  const openid = getOpenId()
  ensureUser(db, openid)
  const idx = db.cards.findIndex((c) => c._id === cloudCard._id)
  const card = {
    ...(idx >= 0 ? db.cards[idx] : {}),
    ...cloudCard,
    _id: cloudCard._id,
    _openid: openid,
    // 详情页优先用本地路径（开发者工具可读）；云 fileID 仍保留
    cutoutPath: localPaths.cutoutPath || cloudCard.cutoutPath || '',
    originalPath: localPaths.originalPath || cloudCard.originalPath || '',
    cutoutFileId: cloudCard.cutoutFileId || '',
    originalFileId: cloudCard.originalFileId || ''
  }
  if (idx >= 0) db.cards[idx] = card
  else db.cards.unshift(card)
  recomputeStats(db, openid)
  save(db)
  return { card }
}

async function updateCard(cardId, patch) {
  const db = load()
  const openid = getOpenId()
  ensureUser(db, openid)
  // 先按 id 找；openid 不一致时认领到当前用户（云端合并卡常见）
  let card = db.cards.find((c) => c._id === cardId)
  if (card && card._openid !== openid) {
    card._openid = openid
  }
  if (!card) throw new Error('card not found')
  Object.assign(card, ensureRecognizedBreedField(card))
  if (card.recognizedBreed === undefined) card.recognizedBreed = ''
  if (patch.name !== undefined) card.name = clampText(patch.name, 12)
  // 品种改动请走 requestBreedChange；此处仅允许内部/审核通过写入
  if (patch.breed !== undefined && patch._breedReviewApply) {
    card.breed = clampText(patch.breed, 20) || UNKNOWN_LABEL
    if (patch.confidence !== undefined) card.confidence = Number(patch.confidence) || 0
    else if (card.breed && card.breed !== UNKNOWN_LABEL && card.breed !== '待识别') {
      if (!card.confidence) card.confidence = 100
    }
  }
  if (patch.confidence !== undefined && patch.breed === undefined) {
    card.confidence = Number(patch.confidence) || 0
  }
  if (patch.pendingBreed !== undefined) card.pendingBreed = patch.pendingBreed || ''
  if (patch.breedReviewStatus !== undefined) card.breedReviewStatus = patch.breedReviewStatus || ''
  if (patch.breedReviewId !== undefined) card.breedReviewId = patch.breedReviewId || ''
  if (patch.recognizedBreed !== undefined) {
    card.recognizedBreed = normalizeRecognizedBreed(patch.recognizedBreed)
  }
  if (patch.note !== undefined) card.note = clampText(patch.note, 100)
  if (patch.placeText !== undefined) card.placeText = clampText(patch.placeText, 30)
  if (patch.geo !== undefined) {
    const { normalizeGeo } = require('../utils/geo-blur')
    card.geo = normalizeGeo(patch.geo)
  }
  if (patch.intimacy !== undefined) card.intimacy = careEngine.normalizeIntimacy(patch.intimacy)
  if (patch.intimacyDay !== undefined) card.intimacyDay = String(patch.intimacyDay || '')
  if (patch.intimacyGainedToday !== undefined) {
    card.intimacyGainedToday = Math.max(0, Number(patch.intimacyGainedToday) || 0)
  }
  if (patch.cutoutPath !== undefined) card.cutoutPath = patch.cutoutPath || ''
  if (patch.originalPath !== undefined) card.originalPath = patch.originalPath || ''
  if (patch.cutoutFileId !== undefined) card.cutoutFileId = patch.cutoutFileId || ''
  if (patch.originalFileId !== undefined) card.originalFileId = patch.originalFileId || ''
  if (patch.mattingFailed !== undefined) card.mattingFailed = !!patch.mattingFailed
  recomputeStats(db, openid)
  save(db)
  return { card }
}

/** 申请改品种：改回识别结果可直接生效，否则进审核 */
async function requestBreedChange(cardId, breed) {
  const db = load()
  const openid = getOpenId()
  const target = clampText(breed || '', 20)
  if (!target) throw new Error('请选择品种')
  let card = db.cards.find((c) => c._id === cardId)
  if (!card) throw new Error('card not found')
  if (card._openid !== openid) card._openid = openid
  Object.assign(card, ensureRecognizedBreedField(card))
  if (card.recognizedBreed === undefined) card.recognizedBreed = ''

  const hadPending = card.breedReviewStatus === 'pending' || !!card.pendingBreed
  if (card.breed === target && !hadPending) {
    return { card, mode: 'noop', toast: '已经是这个品种了' }
  }

  // 不再审核：用户选的品种直接生效，识别结果留在 recognizedBreed 备查
  if (hadPending && Array.isArray(db.breedReviews)) {
    db.breedReviews.forEach((r) => {
      if (r.cardId === cardId && r.status === 'pending') r.status = 'superseded'
    })
  }
  card.breed = target
  card.confidence = 100
  card.pendingBreed = ''
  card.breedReviewStatus = ''
  card.breedReviewId = ''
  recomputeStats(db, openid)
  save(db)
  return { card, mode: 'applied', toast: '已换成「' + target + '」' }
}

async function reviewBreedChange({ reviewId, cardId, approve }) {
  const db = load()
  const openid = getOpenId()
  if (!Array.isArray(db.breedReviews)) db.breedReviews = []
  let review = reviewId ? db.breedReviews.find((r) => r._id === reviewId) : null
  if (!review && cardId) {
    review = db.breedReviews.find((r) => r.cardId === cardId && r.status === 'pending')
  }
  // 审核表缺失时，用卡上的 pending 字段兜底
  let card = review
    ? db.cards.find((c) => c._id === review.cardId)
    : cardId
      ? db.cards.find((c) => c._id === cardId)
      : null
  if ((!review || review.status !== 'pending') && card && (card.breedReviewStatus === 'pending' || card.pendingBreed)) {
    review = {
      _id: card.breedReviewId || uid('brev'),
      _openid: openid,
      cardId: card._id,
      fromBreed: card.breed || '',
      toBreed: card.pendingBreed || '',
      recognizedBreed: card.recognizedBreed || '',
      status: 'pending',
      createdAt: Date.now()
    }
    db.breedReviews.unshift(review)
  }
  if (!review || review.status !== 'pending') throw new Error('没有待审申请')
  if (!card) card = db.cards.find((c) => c._id === review.cardId)
  if (!card) throw new Error('卡牌不存在')

  const toBreed = clampText(review.toBreed || card.pendingBreed || '', 20)
  if (approve) {
    if (!toBreed) throw new Error('缺少目标品种，无法通过')
    review.status = 'approved'
    review.reviewedAt = Date.now()
    review.toBreed = toBreed
    card.breed = toBreed
    card.confidence = 100
    card.pendingBreed = ''
    card.breedReviewStatus = 'approved'
    card.breedReviewId = ''
    recomputeStats(db, openid)
    save(db)
    return { card, toast: '审核已通过，品种已更新' }
  }
  review.status = 'rejected'
  review.reviewedAt = Date.now()
  card.pendingBreed = ''
  card.breedReviewStatus = 'rejected'
  card.breedReviewId = ''
  save(db)
  return { card, toast: '审核未通过，仍保持原品种' }
}

/** 写入/合并本地审核单（云端回包后对齐 id/状态） */
function upsertBreedReview(review = {}) {
  if (!review || !review.cardId) return null
  const db = load()
  const openid = getOpenId()
  if (!Array.isArray(db.breedReviews)) db.breedReviews = []
  const idx = db.breedReviews.findIndex((r) => {
    if (!r) return false
    if (review._id && r._id === review._id) return true
    // 同卡待审单合并，避免本地临时 id 与云端 id 各写一条
    if (r.cardId === review.cardId && r.status === 'pending' && (review.status || 'pending') === 'pending') {
      return true
    }
    return false
  })
  const next = {
    ...(idx >= 0 ? db.breedReviews[idx] : {}),
    ...review,
    _id: review._id || (idx >= 0 && db.breedReviews[idx]._id) || uid('brev'),
    _openid: openid,
    cardId: review.cardId,
    createdAt: review.createdAt || (idx >= 0 && db.breedReviews[idx].createdAt) || Date.now()
  }
  if (idx >= 0) db.breedReviews[idx] = next
  else db.breedReviews.unshift(next)

  const card = db.cards.find((c) => c && c._id === next.cardId)
  if (card) {
    if (next.status === 'pending') {
      card.pendingBreed = next.toBreed || card.pendingBreed || ''
      card.breedReviewStatus = 'pending'
      card.breedReviewId = next._id
    } else if (next.status === 'approved') {
      if (next.toBreed) {
        card.breed = next.toBreed
        card.confidence = card.confidence || 100
      }
      card.pendingBreed = ''
      card.breedReviewStatus = 'approved'
      card.breedReviewId = ''
      recomputeStats(db, openid)
    } else if (next.status === 'rejected' || next.status === 'cancelled') {
      card.pendingBreed = ''
      card.breedReviewStatus = next.status
      card.breedReviewId = ''
    }
  }
  save(db)
  return next
}

async function listBreedReviews({ status } = {}) {
  const db = load()
  const openid = getOpenId()
  if (!Array.isArray(db.breedReviews)) db.breedReviews = []

  // 把图鉴里挂着的 pending 补进审核表（历史提交丢记录 / openid 漂移时）
  const myCards = (db.cards || []).filter((c) => c && (!c._openid || c._openid === openid))
  myCards.forEach((c) => {
    if (!(c.breedReviewStatus === 'pending' || c.pendingBreed)) return
    const exists = db.breedReviews.some(
      (r) =>
        r &&
        r.status === 'pending' &&
        (r._id === c.breedReviewId || r.cardId === c._id)
    )
    if (exists) return
    db.breedReviews.unshift({
      _id: c.breedReviewId || uid('brev'),
      _openid: openid,
      cardId: c._id,
      fromBreed: c.breed || '',
      toBreed: c.pendingBreed || '',
      recognizedBreed: c.recognizedBreed || '',
      status: 'pending',
      createdAt: c.createdAt || Date.now()
    })
    if (!c.breedReviewId) c.breedReviewId = db.breedReviews[0]._id
    if (!c.breedReviewStatus) c.breedReviewStatus = 'pending'
    save(db)
  })

  // openid 对齐：无主或旧主的记录也认到当前用户名下（卡属于我就显示）
  let list = (db.breedReviews || []).filter((r) => {
    if (!r) return false
    if (r._openid === openid || !r._openid) return true
    return myCards.some((c) => c._id === r.cardId)
  })
  list.forEach((r) => {
    if (r._openid !== openid) r._openid = openid
  })
  if (status) list = list.filter((r) => r.status === status)
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
  return { list }
}

async function listMemories(cardId) {
  const db = load()
  const openid = getOpenId()
  const list = db.memories
    .filter((m) => m._openid === openid && m.cardId === cardId)
    .sort((a, b) => a.createdAt - b.createdAt)
  return { memories: list }
}

async function createMemory(payload) {
  const db = load()
  const openid = getOpenId()
  const card = db.cards.find((c) => c._id === payload.cardId && c._openid === openid)
  if (!card) throw new Error('card not found')
  const identity = normalizePhotoIdentity(payload.photoIdentity)
  const memory = {
    _id: uid('mem'),
    _openid: openid,
    cardId: payload.cardId,
    text: clampText(payload.text || '', 200),
    imagePath: payload.imagePath || '',
    imageFileId: payload.imageFileId || '',
    encounter: !!payload.encounter,
    createdAt: Date.now()
  }
  db.memories.push(memory)
  if (identity) card.photoIdentities = appendIdentity(card.photoIdentities, identity)
  // 真实再遇见：遇见次数 +1，小屋亲密度大涨
  if (memory.encounter) {
    card.encounterCount = encounterCountOf(card) + 1
    card.lastSeenAt = memory.createdAt
    card.intimacy = Math.min(100, (Number(card.intimacy) || 0) + ENCOUNTER_INTIMACY)
  }
  recomputeStats(db, openid)
  save(db)
  return { memory }
}

/** 云端建记忆成功后，把本地 mem_* 换成云端 _id，后续删除两边才能对上 */
async function rekeyMemory(localId, cloudMemory) {
  if (!localId || !cloudMemory || !cloudMemory._id) return { memory: null }
  const db = load()
  const idx = db.memories.findIndex((m) => m._id === localId)
  if (idx < 0) return { memory: null }
  const cur = db.memories[idx]
  db.memories[idx] = {
    ...cur,
    ...cloudMemory,
    _openid: cur._openid,
    // 本地图片路径优先（开发者工具可读）
    imagePath: cur.imagePath || cloudMemory.imagePath || ''
  }
  save(db)
  return { memory: db.memories[idx] }
}

async function deleteMemory(memoryId) {
  const db = load()
  const openid = getOpenId()
  const idx = db.memories.findIndex((m) => m._id === memoryId && m._openid === openid)
  // 只存在云端的记忆：本地没有也算成功，让云端删除继续执行
  if (idx < 0) return { ok: true, cardId: '', localMissing: true }
  const cardId = db.memories[idx].cardId
  db.memories.splice(idx, 1)
  recomputeStats(db, openid)
  save(db)
  return { ok: true, cardId }
}

/** 预留：异步切磋结果回写（V1 不挂入口） */
async function reportDuelResult({ myCardId, peerCardId, outcome }) {
  const db = load()
  const openid = getOpenId()
  const card = db.cards.find((c) => c._id === myCardId && c._openid === openid)
  if (!card) throw new Error('card not found')
  if (!card.recordStats) {
    card.recordStats = { duelWins: 0, duelLosses: 0, lastDuelAt: 0 }
  }
  if (outcome === 'win') card.recordStats.duelWins += 1
  else if (outcome === 'lose') card.recordStats.duelLosses += 1
  card.recordStats.lastDuelAt = Date.now()
  db.duels.push({
    _id: uid('duel'),
    _openid: openid,
    myCardId,
    peerCardId: peerCardId || '',
    outcome,
    createdAt: Date.now()
  })
  save(db)
  return { card }
}

function breedFilters() {
  const db = load()
  const openid = getOpenId()
  const counts = {}
  db.cards
    .filter((c) => c._openid === openid)
    .forEach((c) => {
      counts[c.breed] = (counts[c.breed] || 0) + 1
    })
  return Object.keys(counts)
    .map((breed) => ({ breed, count: counts[breed] }))
    .sort((a, b) => b.count - a.count)
}

module.exports = {
  login,
  bindCloudOpenId,
  getOpenId,
  getProfile,
  updateProfile,
  addCardToRoom,
  removeCardFromRoom,
  setRoomMain,
  recognize,
  listCards,
  getCard,
  createCard,
  mirrorCloudCard,
  rekeyCard,
  releasedCardIds,
  updateCard,
  requestBreedChange,
  reviewBreedChange,
  listBreedReviews,
  upsertBreedReview,
  listMemories,
  createMemory,
  rekeyMemory,
  deleteMemory,
  reportDuelResult,
  breedFilters,
  getRoomState,
  careCat,
  saveRoomFurniture,
  releaseCard,
  listMyReleased,
  adoptVisitor,
  listVisitLogs,
  interactVisitor,
  dismissReport,
  dismissLeftTrace,
  listOutingLogs,
  debugAdvanceOuting
}
