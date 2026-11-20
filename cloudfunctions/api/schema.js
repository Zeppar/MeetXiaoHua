/**
 * 云数据库集合约定（在云开发控制台手动创建同名集合）
 *
 * users:
 *   nickName, avatarUrl, displayCardId(焦点猫/出门用), roomMateIds[](同住，地位相同，最多另2只), roomBackgroundId,
 *   stats{cardCount,breedCount,memoryCount}, privacyAgreedAt, createdAt
 *
 * cards:
 *   cutoutFileId, originalFileId, cutoutPath, originalPath,
 *   breed, confidence, shotAt, note, placeText, geo{lat,lng},
 *   mattingFailed, memoryCount,
 *   intimacy, intimacyDay, intimacyGainedToday, // 亲密度 0~100，按猫累计
 *   recordStats{duelWins,duelLosses,lastDuelAt}  // 异步切磋预留，V1 UI 不展示
 *   createdAt
 *
 * memories:
 *   cardId, text, imageFileId, imagePath, createdAt
 *
 * duels:  // V1 仅预留集合，业务由 reportDuelResult 写入
 *   myCardId, peerCardId, outcome('win'|'lose'|'draw'), createdAt
 *
 * visits:  // 猫猫串门
 *   hostOpenId, ownerOpenId, guestCardId, breed, cutoutPath,
 *   behaviorText, distanceKm, arriveAt, leaveAt,
 *   status('active'|'left'), petByHost, fedByHost, seenLeft
 *
 * outingLogs:  // 出门历史（归属主人）
 *   cardId, distanceKm, behaviorText, pet, fed, leftAt, returnedAt
 *
 * users 扩展:
 *   settings{allowMyCatOut,allowVisitors,showDistance},
 *   outing{status,cardId,homeSince,...unreadReport}, fedDate, fuzzyGeo
 *
 * 建议索引：
 *   cards: _openid + shotAt desc
 *   memories: _openid + cardId + createdAt asc
 *   visits: hostOpenId + status + leaveAt
 *   outingLogs: _openid + cardId + returnedAt desc
 */
module.exports = {}
