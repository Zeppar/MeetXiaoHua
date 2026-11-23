/** 小屋背景解锁规则（按「一共遇见猫的次数」：建卡算一次，再遇见同一只再加一次） */
const BACKGROUNDS = [
  {
    id: 'default',
    name: '青瓷小屋',
    unlockEncounters: 0,
    colors: ['#eaf3ee', '#dde8e0', '#cbb79a']
  },
  {
    id: 'warm_sun',
    name: '暖阳小屋',
    unlockEncounters: 3,
    colors: ['#fff3e0', '#ffe0b5', '#e8b86a']
  },
  {
    id: 'night_lamp',
    name: '夜灯小屋',
    unlockEncounters: 8,
    colors: ['#1b2430', '#2a3544', '#d4a35a']
  },
  {
    id: 'garden',
    name: '花园小屋',
    unlockEncounters: 15,
    colors: ['#e5f4e2', '#cfe8c8', '#8fbf7a']
  }
]

function getUnlockNeed(bg, encounterTotal) {
  const need = bg.unlockEncounters - encounterTotal
  return need > 0 ? need : 0
}

function isUnlocked(bg, encounterTotal) {
  return encounterTotal >= bg.unlockEncounters
}

module.exports = {
  BACKGROUNDS,
  getUnlockNeed,
  isUnlocked
}
