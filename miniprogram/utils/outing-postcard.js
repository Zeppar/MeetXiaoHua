const { BEHAVIORS } = require('../constants/outing')

// 与出门行为对应。文字不使用「你家」，主人和接待方回看时都能读懂。
const MOMENTS = [
  '刚到门口，它就翻了个身，露出软乎乎的肚皮。',
  '它在小屋里坐了下来，安安静静地看了好一会儿。',
  '窗台暖融融的，它就在那儿打了个盹。',
  '它绕着猫窝转了三圈，才找好地方坐下。',
  '它在门口坐了一会儿，耳朵时不时朝屋里转。',
  '它凑近猫粮碗闻了闻，又慢悠悠地走开了。',
  '它在小屋里溜达了一圈，留下几枚梅花印。',
  '它舒舒服服地趴了下来，眼睛慢慢眯成一条线。'
]

function formatOutingPostcard(entry, options = {}) {
  if (!entry) return null
  const behavior = entry.behaviorLine || entry.behaviorText || ''
  const index = MOMENTS[entry.behaviorIndex] ? entry.behaviorIndex : BEHAVIORS.indexOf(behavior)
  const parts = [MOMENTS[index] || behavior]
  if (entry.pet) parts.push('它舒服地挨了几下摸摸。')
  if (entry.fed) parts.push('还蹭到了一颗猫粮。')
  if (entry.adopted) parts.push('这次，它的卡片被人收下了。')
  // 它的地盘：用模糊过的相遇地点，给出门找它一个理由
  if (entry.territory && !options.inbound) parts.push(`听说它最近常在「${entry.territory}」一带出没，出门时留意一下。`)
  if (entry.pet === undefined && entry.fed === undefined && entry.interactLine) {
    parts.push(entry.interactLine)
  }

  const friend = entry.friend
  let friendImage = ''
  let friendCaption = ''
  if (friend && friend.image) {
    friendImage = friend.image
    if (friend.kind === 'illustration') {
      friendCaption = `新朋友「${friend.name || '麦团'}」 · 插画`
    } else {
      friendCaption = options.inbound ? '它和你家的小猫交了朋友' : '带回了新朋友的照片'
    }
  }

  return {
    story: parts.filter(Boolean).join('') || (options.inbound ? '它来小屋坐了一会儿。' : '它出去转了一圈，平安回到了小屋。'),
    catImage: options.catImage || entry.catImage || '',
    sceneImage: index === 2 ? '/assets/art/furn-window.svg' : '/assets/art/room-bg.svg',
    friendImage,
    friendCaption,
    simulated: !!entry.simulated
  }
}

module.exports = { formatOutingPostcard }
