/**
 * 宠物品种识别入口（可切换厂商）
 *
 * 环境变量 / secrets.local.js：
 *   RECOGNIZE_PROVIDER = baidu | tencent   （默认 baidu）
 *   百度：BAIDU_API_KEY / BAIDU_SECRET_KEY
 *   腾讯：TENCENT_SECRET_ID / TENCENT_SECRET_KEY
 */
const { getRecognizeConfig } = require('./recognize-config')
const { CONFIDENCE_THRESHOLD, UNKNOWN_LABEL } = require('./breed-map')

const providers = {
  baidu: () => require('./providers/baidu'),
  tencent: () => require('./providers/tencent')
}

async function recognizePet(input = {}) {
  const { provider } = getRecognizeConfig()
  console.log('[recognizePet] provider =', provider)

  const loader = providers[provider]
  if (!loader) {
    return {
      ok: false,
      code: 'BAD_PROVIDER',
      message: `不支持的识别厂商: ${provider}（请用 baidu 或 tencent）`,
      breed: '',
      confidence: 0,
      provider,
      rawDebug: {
        text: `RECOGNIZE_PROVIDER=${provider} 无效，可选：baidu / tencent`
      }
    }
  }

  const mod = loader()
  return mod.recognizePet(input)
}

module.exports = {
  recognizePet,
  CONFIDENCE_THRESHOLD,
  UNKNOWN_LABEL,
  getRecognizeConfig
}
