/**
 * 腾讯云抠图：人体分析 · 人像分割 SegmentPortraitPic
 * 说明：接口按「人像」训练，对猫毛边通常一般；此处用于和百度单独对比。
 * 文档：https://cloud.tencent.com/document/api/1208/42970
 */
const tencentcloud = require('tencentcloud-sdk-nodejs')
const { getRecognizeConfig } = require('../recognize-config')

const BdaClient = tencentcloud.bda.v20200324.Client

function normalizeBase64(input) {
  const raw = String(input || '')
  const idx = raw.indexOf('base64,')
  return idx >= 0 ? raw.slice(idx + 7) : raw
}

function getClient() {
  const { tencent } = getRecognizeConfig()
  const { secretId, secretKey, region } = tencent
  if (!secretId || !secretKey) {
    const err = new Error(
      '未配置腾讯云密钥：请填 TENCENT_SECRET_ID / TENCENT_SECRET_KEY'
    )
    err.code = 'NO_TENCENT_KEY'
    throw err
  }
  return new BdaClient({
    credential: { secretId, secretKey },
    region: region || 'ap-guangzhou',
    profile: {
      httpProfile: { endpoint: 'bda.tencentcloudapi.com' }
    }
  })
}

async function matting({ imageBase64, imageUrl } = {}) {
  const started = Date.now()
  const b64 = normalizeBase64(imageBase64)
  if (!b64 && !imageUrl) {
    return { ok: false, code: 'NO_IMAGE', message: '缺少图片', provider: 'tencent' }
  }

  try {
    const client = getClient()
    const params = {
      RspImgType: 'base64',
      Scene: 'GEN'
    }
    if (imageUrl) params.Url = String(imageUrl)
    else params.Image = b64

    const res = await client.SegmentPortraitPic(params)
    const outB64 = normalizeBase64(res && res.ResultImage)
    if (!outB64) {
      return {
        ok: false,
        code: 'TENCENT_MATTING_ERROR',
        message:
          res && res.HasForeground === false
            ? '腾讯未检测到可分割前景（人像接口对猫常无效）'
            : '腾讯抠图未返回图片',
        provider: 'tencent',
        timing: [`腾讯人像分割: ${Date.now() - started}ms`]
      }
    }

    return {
      ok: true,
      provider: 'tencent',
      imageBase64: outB64,
      mime: 'image/png',
      timing: [`腾讯人像分割: ${Date.now() - started}ms`]
    }
  } catch (e) {
    console.warn('[matting-tencent] fail', e)
    return {
      ok: false,
      code: (e && e.code) || 'TENCENT_MATTING_ERROR',
      message: (e && e.message) || '腾讯抠图失败',
      provider: 'tencent',
      timing: [`腾讯人像分割: ${Date.now() - started}ms`]
    }
  }
}

module.exports = {
  matting,
  provider: 'tencent'
}
