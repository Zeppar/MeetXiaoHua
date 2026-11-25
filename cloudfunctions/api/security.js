/**
 * 内容安全：会展示给其他用户的文字 / 图片必须过微信内容安全
 * - 文字（猫名、地点、昵称、明信片）：msgSecCheck v2，同步判断
 * - 图片（贴纸）：mediaCheckAsync v2，异步，结果由「消息推送」回调到本云函数
 * 接口异常时放行并打日志：不能因为检测服务抖动挡住正常用户
 */
const cloud = require('wx-server-sdk')

/** scene：1 资料 2 评论 3 论坛 4 社交日志 */
const SCENE = { PROFILE: 1, COMMENT: 2, FORUM: 3, SOCIAL_LOG: 4 }

async function checkText(openid, content, scene = SCENE.PROFILE) {
  const text = String(content || '').trim()
  if (!text || !openid) return { pass: true }
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      openid,
      scene,
      version: 2,
      content: text.slice(0, 2500)
    })
    const suggest = (res && res.result && res.result.suggest) || 'pass'
    return { pass: suggest !== 'risky', suggest }
  } catch (e) {
    console.warn('[security] msgSecCheck fail, allow', e && (e.errCode || e.message))
    return { pass: true, error: true }
  }
}

/** 一次检查多段文字，返回不通过的字段名 */
async function checkTexts(openid, fields, scene = SCENE.PROFILE) {
  const keys = Object.keys(fields).filter((k) => String(fields[k] || '').trim())
  const results = await Promise.all(keys.map((k) => checkText(openid, fields[k], scene)))
  return keys.filter((k, i) => !results[i].pass)
}

/** 提交图片异步检测，返回 traceId（失败返回空串） */
async function submitImageCheck(openid, fileId, scene = SCENE.PROFILE) {
  if (!openid || !/^cloud:\/\//.test(fileId || '')) return ''
  try {
    const tmp = await cloud.getTempFileURL({ fileList: [fileId] })
    const url = tmp && tmp.fileList && tmp.fileList[0] && tmp.fileList[0].tempFileURL
    if (!url) return ''
    const res = await cloud.openapi.security.mediaCheckAsync({
      mediaUrl: url,
      mediaType: 2,
      version: 2,
      scene,
      openid
    })
    return (res && (res.traceId || res.trace_id)) || ''
  } catch (e) {
    console.warn('[security] mediaCheckAsync fail', e && (e.errCode || e.message))
    return ''
  }
}

/** 消息推送回调：{ Event: 'wxa_media_check', trace_id, result: { suggest } } */
function parseMediaCheckEvent(event) {
  if (!event || event.Event !== 'wxa_media_check') return null
  const traceId = event.trace_id || event.traceId || ''
  const result = event.result || {}
  const suggest = result.suggest || (Number(event.isrisky) === 1 ? 'risky' : 'pass')
  return traceId ? { traceId, risky: suggest === 'risky' } : null
}

module.exports = { SCENE, checkText, checkTexts, submitImageCheck, parseMediaCheckEvent }
