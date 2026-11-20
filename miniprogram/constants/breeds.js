/** 第一版品种白名单 */
const CAT_BREEDS = [
  '中华田园猫',
  '橘猫',
  '狸花猫',
  '英国短毛猫',
  '美国短毛猫',
  '布偶猫',
  '暹罗猫',
  '加菲猫'
]

const DOG_BREEDS = [
  '中华田园犬',
  '金毛',
  '泰迪',
  '柯基',
  '哈士奇',
  '拉布拉多'
]

const OTHER_BREEDS = [
  '麻雀',
  '鸽子',
  '喜鹊',
  '兔子',
  '松鼠',
  '鸭子',
  '鹅'
]

const WHITELIST = [...CAT_BREEDS, ...DOG_BREEDS, ...OTHER_BREEDS]

const UNKNOWN_LABEL = '未知小动物'
const CONFIDENCE_THRESHOLD = 70

module.exports = {
  CAT_BREEDS,
  DOG_BREEDS,
  OTHER_BREEDS,
  WHITELIST,
  UNKNOWN_LABEL,
  CONFIDENCE_THRESHOLD
}
