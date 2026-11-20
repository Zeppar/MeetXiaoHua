/**
 * 各家识别结果 → 产品白名单品种
 * 狸花等中文花色靠前，避免被「猫/英短」泛标签抢先映射
 */
const BREED_ALIASES = [
  ['狸花猫', ['狸花猫', '狸花', '中国狸花', '龙狸', '虎斑猫', '虎斑', 'tabby']],
  ['橘猫', ['橘猫', '桔猫', '橙子猫', '橘']],
  ['中华田园猫', ['中华田园猫', '田园猫', '土猫', '家猫']],
  ['布偶猫', ['布偶猫', '布偶']],
  ['暹罗猫', ['暹罗猫', '暹罗']],
  ['加菲猫', ['加菲猫', '加菲']],
  ['美国短毛猫', ['美国短毛猫', '美短']],
  ['英国短毛猫', ['英国短毛猫', '英短', '英短蓝猫', '蓝猫']],
  ['金毛', ['金毛', '金毛寻回犬']],
  ['泰迪', ['泰迪', '贵宾', '泰迪犬']],
  ['柯基', ['柯基', '柯基犬']],
  ['哈士奇', ['哈士奇', '二哈']],
  ['拉布拉多', ['拉布拉多', '拉布']],
  ['中华田园犬', ['中华田园犬', '土狗']],
  ['兔子', ['兔子', '兔']],
  ['松鼠', ['松鼠']],
  ['麻雀', ['麻雀']],
  ['鸽子', ['鸽子']],
  ['喜鹊', ['喜鹊']],
  ['鸭子', ['鸭子', '鸭']],
  ['鹅', ['鹅']],
  // 过宽标签放最后兜底
  ['中华田园猫', ['猫', '猫咪', '小猫', 'cat']],
  ['中华田园犬', ['狗', '狗狗', '犬', 'dog']]
]

const UNKNOWN_LABEL = '未知小动物'
const CONFIDENCE_THRESHOLD = 70

function mapLabelToBreed(name) {
  const text = String(name || '').trim().toLowerCase()
  if (!text) return ''
  for (let i = 0; i < BREED_ALIASES.length; i++) {
    const breed = BREED_ALIASES[i][0]
    const aliases = BREED_ALIASES[i][1]
    for (let j = 0; j < aliases.length; j++) {
      const a = String(aliases[j]).toLowerCase()
      if (text === a || text.indexOf(a) >= 0) return breed
    }
  }
  return ''
}

function pickBreedFromLabels(labels, petName) {
  const list = Array.isArray(labels) ? labels.slice() : []
  list.sort((a, b) => (b.Confidence || 0) - (a.Confidence || 0))
  for (let i = 0; i < list.length; i++) {
    const mapped = mapLabelToBreed(list[i].Name)
    if (mapped) {
      return {
        breed: mapped,
        confidence: Math.max(0, Math.min(100, Number(list[i].Confidence) || 0)),
        rawName: list[i].Name
      }
    }
  }
  if (petName === 'cat') return { breed: '中华田园猫', confidence: 0, rawName: '' }
  if (petName === 'dog') return { breed: '中华田园犬', confidence: 0, rawName: '' }
  return { breed: UNKNOWN_LABEL, confidence: 0, rawName: '' }
}

function isCatName(name) {
  const n = String(name || '')
  if (!n || /猫粮|猫砂|猫头鹰|猫眼/.test(n)) return false
  return (
    n === '猫' ||
    n.indexOf('猫') >= 0 ||
    n.toLowerCase() === 'cat' ||
    /英短|美短|布偶|暹罗|狸花|橘|加菲|田园猫|波斯|缅因|无毛|折耳/.test(n)
  )
}

function isDogName(name) {
  const n = String(name || '')
  if (!n || /热狗|狗尾草/.test(n)) return false
  return (
    n === '狗' ||
    /犬/.test(n) ||
    n.toLowerCase() === 'dog' ||
    /金毛|泰迪|柯基|哈士奇|拉布|柴犬|边牧/.test(n)
  )
}

module.exports = {
  BREED_ALIASES,
  UNKNOWN_LABEL,
  CONFIDENCE_THRESHOLD,
  mapLabelToBreed,
  pickBreedFromLabels,
  isCatName,
  isDogName
}
