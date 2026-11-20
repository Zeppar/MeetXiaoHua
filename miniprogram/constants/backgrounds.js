/** 小屋背景解锁规则（按「不同品种数」） */
const BACKGROUNDS = [
  {
    id: 'default',
    name: '青瓷小屋',
    unlockDistinctBreeds: 0,
    colors: ['#eaf3ee', '#dde8e0', '#cbb79a']
  },
  {
    id: 'warm_sun',
    name: '暖阳小屋',
    unlockDistinctBreeds: 2,
    colors: ['#fff3e0', '#ffe0b5', '#e8b86a']
  },
  {
    id: 'night_lamp',
    name: '夜灯小屋',
    unlockDistinctBreeds: 4,
    colors: ['#1b2430', '#2a3544', '#d4a35a']
  },
  {
    id: 'garden',
    name: '花园小屋',
    unlockDistinctBreeds: 7,
    colors: ['#e5f4e2', '#cfe8c8', '#8fbf7a']
  }
]

function getUnlockNeed(bg, distinctCount) {
  const need = bg.unlockDistinctBreeds - distinctCount
  return need > 0 ? need : 0
}

function isUnlocked(bg, distinctCount) {
  return distinctCount >= bg.unlockDistinctBreeds
}

module.exports = {
  BACKGROUNDS,
  getUnlockNeed,
  isUnlocked
}
