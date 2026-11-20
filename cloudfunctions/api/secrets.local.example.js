/**
 * 复制为 secrets.local.js 后填入真实密钥（secrets.local.js 已被 gitignore）
 */
module.exports = {
  // baidu | tencent
  RECOGNIZE_PROVIDER: 'baidu',

  // 百度：控制台 → 图像识别 → 应用列表 → API Key / Secret Key
  BAIDU_API_KEY: '',
  BAIDU_SECRET_KEY: '',

  // 腾讯（保留；RECOGNIZE_PROVIDER=tencent 时使用）
  TENCENT_SECRET_ID: '',
  TENCENT_SECRET_KEY: '',
  TENCENT_REGION: 'ap-guangzhou'
}
