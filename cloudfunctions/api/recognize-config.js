/**
 * 识别 / 抠图厂商配置
 * RECOGNIZE_PROVIDER: baidu | tencent（默认 baidu）
 * MATTING_PROVIDER: baidu | tencent | rembg | local（默认 baidu）
 * 小程序可在单次 matting 请求里用 provider 覆盖
 */
function loadLocalSecrets() {
  try {
    // eslint-disable-next-line import/no-unresolved, global-require
    return require('./secrets.local.js')
  } catch (e) {
    return {}
  }
}

function normalizeMattingProvider(raw) {
  const v = String(raw || 'baidu')
    .trim()
    .toLowerCase()
  if (v === 'rembg' || v === 'local' || v === 'baidu' || v === 'tencent') return v
  return 'baidu'
}

function getRecognizeConfig() {
  const local = loadLocalSecrets()
  const provider = String(
    process.env.RECOGNIZE_PROVIDER || local.RECOGNIZE_PROVIDER || 'baidu'
  )
    .trim()
    .toLowerCase()
  const mattingProvider = normalizeMattingProvider(
    process.env.MATTING_PROVIDER || local.MATTING_PROVIDER || 'baidu'
  )

  return {
    provider: provider === 'tencent' ? 'tencent' : provider === 'baidu' ? 'baidu' : provider,
    mattingProvider,
    local,
    tencent: {
      secretId: process.env.TENCENT_SECRET_ID || local.TENCENT_SECRET_ID || '',
      secretKey: process.env.TENCENT_SECRET_KEY || local.TENCENT_SECRET_KEY || '',
      region: process.env.TENCENT_REGION || local.TENCENT_REGION || 'ap-guangzhou'
    },
    baidu: {
      // 动物识别应用
      apiKey: process.env.BAIDU_API_KEY || local.BAIDU_API_KEY || '',
      secretKey: process.env.BAIDU_SECRET_KEY || local.BAIDU_SECRET_KEY || '',
      // 智能抠图应用（可与识别不同；不填则回退上面那对）
      mattingApiKey:
        process.env.BAIDU_MATTING_API_KEY || local.BAIDU_MATTING_API_KEY || '',
      mattingSecretKey:
        process.env.BAIDU_MATTING_SECRET_KEY || local.BAIDU_MATTING_SECRET_KEY || '',
      // 智能抠图参数（官方可选项很少）
      mattingMethod:
        process.env.BAIDU_MATTING_METHOD || local.BAIDU_MATTING_METHOD || 'auto',
      mattingRefineMask: String(
        process.env.BAIDU_MATTING_REFINE_MASK || local.BAIDU_MATTING_REFINE_MASK || 'true'
      ),
      mattingReturnForm:
        process.env.BAIDU_MATTING_RETURN_FORM || local.BAIDU_MATTING_RETURN_FORM || 'rgba'
    },
    rembg: {
      url: process.env.REMBG_URL || local.REMBG_URL || '',
      // 默认轻量快速 u2netp；要更细可用 u2net / u2net_animal
      model: process.env.REMBG_MODEL || local.REMBG_MODEL || 'u2netp',
      // Alpha matting 边缘细化（更慢，边缘更干净）
      alphaMatting: String(process.env.REMBG_ALPHA || local.REMBG_ALPHA || 'false') === 'true',
      alphaForeground: Number(process.env.REMBG_AF || local.REMBG_AF || 240),
      alphaBackground: Number(process.env.REMBG_AB || local.REMBG_AB || 10),
      alphaErode: Number(process.env.REMBG_AE || local.REMBG_AE || 10)
    }
  }
}

module.exports = {
  loadLocalSecrets,
  getRecognizeConfig
}
