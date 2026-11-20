/**
 * 抠图入口（可切换）
 * MATTING_PROVIDER: baidu | tencent | rembg | local
 * 也可在请求里传 provider 覆盖默认配置（供小程序对比模式）
 * local 表示云端不处理，由小程序本地洪水填充兜底
 */
const { getRecognizeConfig } = require('./recognize-config')

const providers = {
  baidu: () => require('./providers/matting-baidu'),
  tencent: () => require('./providers/matting-tencent'),
  rembg: () => require('./providers/matting-rembg')
}

function resolveProvider(input = {}) {
  const override = String(input.provider || '')
    .trim()
    .toLowerCase()
  if (override === 'baidu' || override === 'tencent' || override === 'rembg' || override === 'local') {
    return override
  }
  return getRecognizeConfig().mattingProvider
}

async function matting(input = {}) {
  const mattingProvider = resolveProvider(input)
  console.log('[matting] provider =', mattingProvider)

  if (mattingProvider === 'local') {
    return {
      ok: false,
      code: 'USE_LOCAL',
      message: '配置为本地抠图',
      provider: 'local'
    }
  }

  const loader = providers[mattingProvider]
  if (!loader) {
    return {
      ok: false,
      code: 'BAD_PROVIDER',
      message: `不支持的抠图厂商: ${mattingProvider}（baidu / tencent / rembg / local）`,
      provider: mattingProvider
    }
  }

  try {
    return await loader().matting(input)
  } catch (e) {
    console.warn('[matting] fail', e)
    return {
      ok: false,
      code: (e && e.code) || 'MATTING_ERROR',
      message: (e && e.message) || '抠图失败',
      provider: mattingProvider
    }
  }
}

module.exports = {
  matting,
  resolveProvider
}
