/**
 * 异步切磋预留接口（V1 不挂任何入口）
 * 胜负只回写小猫 recordStats，不做排行榜。
 */
const api = require('./api')

/**
 * @param {{ myCardId: string, peerCardId?: string, outcome: 'win'|'lose'|'draw' }} payload
 */
function reportDuelResult(payload) {
  return api.reportDuelResult(payload)
}

module.exports = {
  reportDuelResult
}
