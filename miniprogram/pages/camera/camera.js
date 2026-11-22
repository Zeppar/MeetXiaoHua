const api = require('../../services/api')
const { findCatMatches } = require('../../services/cat-identity')
const copy = require('../../constants/copy')
const { UNKNOWN_LABEL, CAT_BREEDS } = require('../../constants/breeds')
const { blurCoordinate, isValidGeo, getCurrentPosition } = require('../../utils/geo-blur')
const nav = require('../../utils/navigate')
const { makeStickerWithCloudMatting } = require('../../services/cloud-matting')
const mattingMode = require('../../constants/matting-mode')
const { isDevBuild } = require('../../utils/env')

// false：暂关闭云识别，只做抠图白边；改回 true 恢复识别
const RECOGNITION_ENABLED = true

function resolveMode() {
  return mattingMode.getMode ? mattingMode.getMode() : mattingMode.MODE || 'lite'
}

function timeoutForMode(mode) {
  if (mode === 'quality' || mode === 'rembg') return 180000
  if (mode === 'baidu' || mode === 'tencent' || mode === 'fast') return 50000
  // 极速含腾讯取框，给足云调用时间
  return 60000
}

function recognizingTextForMode(mode) {
  if (RECOGNITION_ENABLED) return copy.tips.recognizing
  const opt = mattingMode.getOption ? mattingMode.getOption(mode) : null
  return (opt && opt.recognizing) || '抠图中…'
}

function formatMs(ms) {
  const n = Math.max(0, Number(ms) || 0)
  if (n >= 1000) return `${(n / 1000).toFixed(1)}s`
  return `${Math.round(n)}ms`
}

/** 邮戳上的日期，如 11.20 */
function stampDateText(d = new Date()) {
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${mm}.${dd}`
}

/** 把 timing 字符串数组解析成步骤列表 + 总耗时 */
function buildTimingView(timingLines, fallbackTotalMs) {
  const lines = Array.isArray(timingLines) ? timingLines : []
  const steps = []
  let totalMs = 0
  lines.forEach((raw) => {
    const s = String(raw || '').trim()
    if (!s) return
    const m = s.match(/^(.*?):\s*(\d+)\s*ms(.*)$/i)
    if (m) {
      const label = String(m[1] || '').trim()
      const ms = Number(m[2]) || 0
      const extra = String(m[3] || '').trim()
      if (/总耗时/.test(label)) {
        totalMs = ms
        return
      }
      steps.push({
        label,
        ms,
        text: `${label}  ${formatMs(ms)}${extra ? ' ' + extra : ''}`
      })
      return
    }
    steps.push({ label: s, ms: 0, text: s })
  })
  if (!totalMs && fallbackTotalMs != null) totalMs = Math.max(0, Number(fallbackTotalMs) || 0)
  return {
    steps,
    totalMs,
    totalText: totalMs ? `总耗时 ${formatMs(totalMs)}` : '',
    lines
  }
}

Page({
  data: {
    // 耗时明细、抠图类型切换只给开发者看：开发版（含开发者工具）显示，体验版/正式版隐藏
    showTiming: isDevBuild(),
    state: 'ready', // ready | recognizing | preview | fail
    tempPath: '',
    result: null,
    failMessage: '',
    failCode: '',
    showCameraAuth: false,
    showLocationAuth: false,
    showNoteModal: false,
    showPlaceModal: false,
    checkingMatches: false,
    catMatches: [],
    note: '',
    placeText: '',
    geo: null,
    locating: false,
    locationHint: '',
    saving: false,
    shootHint: copy.tips.shootHint,
    mattingMode: resolveMode(),
    mattingOptions: mattingMode.OPTIONS || [],
    recognizingText: recognizingTextForMode(resolveMode()),
    unknownLabel: UNKNOWN_LABEL,
    unknownHint: copy.tips.unknownHint,
    mattingFailed: copy.tips.mattingFailed,
    retakeText: copy.buttons.retake,
    retakeAgainText: copy.buttons.retakeAgain,
    saveText: copy.buttons.saveAlbum,
    retryText: copy.buttons.retry,
    backHomeText: copy.buttons.backHome,
    cameraTitle: copy.modals.cameraTitle,
    cameraBody: copy.modals.cameraBody,
    notNowText: copy.buttons.notNow,
    goSettingsText: copy.buttons.goSettings,
    noteTitle: copy.modals.noteTitle,
    notePlaceholder: copy.modals.notePlaceholder,
    noteMax: copy.limits.note,
    placeTitle: copy.modals.placeTitle,
    placePlaceholder: copy.modals.placePlaceholder,
    placeOnlyYou: copy.tips.privacyOnlyYou,
    placeMax: copy.limits.place,
    useLocationText: copy.modals.useLocation,
    locationTitle: copy.modals.locationTitle,
    locationBody: copy.modals.locationBody,
    skipText: copy.buttons.skip,
    cancelText: '取消',
    saveBtnText: copy.buttons.save,
    doneText: copy.buttons.done,
    pageLoading: false,
    loadingText: copy.tips.pageLoading,
    timingElapsedText: '',
    timingSteps: [],
    timingTotalText: '',
    showBreedPicker: false,
    breedOptions: CAT_BREEDS.slice()
  },

  recognizeToken: 0,
  recognizeTimer: null,
  elapsedTimer: null,
  mattingStartedAt: 0,
  mattingCanvas: null,

  onReady() {
    this.initMattingCanvas()
    try {
      wx.createSelectorQuery().select('#identityCanvas').fields({ node: true }).exec((res) => {
        this.identityCanvas = res && res[0] && res[0].node
      })
    } catch (e) {
      // 查重仍可使用离屏画布或文件摘要。
    }
  },

  onShow() {
    const mode = resolveMode()
    this.setData({
      mattingMode: mode,
      mattingOptions: mattingMode.OPTIONS || [],
      recognizingText: recognizingTextForMode(mode)
    })
  },

  onUnload() {
    this.__mxhUnloaded = true
    this.recognizeToken += 1
    this.clearRecognizeTimer()
    this.clearElapsedTimer()
  },

  noop() {},

  onSelectMattingMode(e) {
    const id = e && e.currentTarget && e.currentTarget.dataset && e.currentTarget.dataset.id
    if (!id) return
    const mode = mattingMode.setMode ? mattingMode.setMode(id) : id
    this.setData({
      mattingMode: mode,
      recognizingText: recognizingTextForMode(mode)
    })
    wx.showToast({
      title: (mattingMode.getOption(mode) || {}).label || mode,
      icon: 'none',
      duration: 900
    })
  },

  initMattingCanvas() {
    try {
      const query = wx.createSelectorQuery()
      query
        .select('#mattingCanvas')
        .fields({ node: true, size: true })
        .exec((res) => {
          const canvas = res && res[0] && res[0].node
          if (canvas) this.mattingCanvas = canvas
        })
    } catch (e) {
      /* ignore */
    }
  },

  clearRecognizeTimer() {
    if (this.recognizeTimer) {
      clearTimeout(this.recognizeTimer)
      this.recognizeTimer = null
    }
  },

  clearElapsedTimer() {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer)
      this.elapsedTimer = null
    }
  },

  startElapsedTimer() {
    this.clearElapsedTimer()
    this.mattingStartedAt = Date.now()
    this.setData({
      timingElapsedText: '已用时 0.0s',
      timingSteps: [],
      timingTotalText: ''
    })
    this.elapsedTimer = setInterval(() => {
      if (this.__mxhUnloaded) {
        this.clearElapsedTimer()
        return
      }
      const ms = Date.now() - (this.mattingStartedAt || Date.now())
      this.setData({ timingElapsedText: `已用时 ${(ms / 1000).toFixed(1)}s` })
    }, 200)
  },

  onShoot() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera'],
      camera: 'back',
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        if (!file || !file.tempFilePath) return
        this.startRecognize(file.tempFilePath)
      },
      fail: (err) => {
        const msg = (err && err.errMsg) || ''
        if (msg.indexOf('cancel') >= 0 || msg.indexOf('取消') >= 0) return
        wx.showModal({
          title: '无法使用相机',
          content: '当前环境可能没有相机，可以用「上传图片识别」继续。',
          confirmText: '去上传',
          cancelText: '取消',
          success: (r) => {
            if (r.confirm) this.onUpload()
          }
        })
      }
    })
  },

  onUpload() {
    const handlePath = (path) => {
      if (!path) {
        wx.showToast({ title: '未选到图片', icon: 'none' })
        return
      }
      this.startRecognize(path)
    }

    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['album'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0]
        handlePath(file && file.tempFilePath)
      },
      fail: () => {
        wx.chooseImage({
          count: 1,
          sizeType: ['compressed'],
          sourceType: ['album'],
          success: (res) => handlePath(res.tempFilePaths && res.tempFilePaths[0]),
          fail: () => wx.showToast({ title: '选图失败，请重试', icon: 'none' })
        })
      }
    })
  },

  onAuthCancel() {
    this.setData({ showCameraAuth: false, showLocationAuth: false })
  },

  onOpenSetting() {
    this.setData({ showCameraAuth: false, showLocationAuth: false })
    wx.openSetting({})
  },

  finishRecognize(token, patch) {
    if (token !== this.recognizeToken) return
    this.clearRecognizeTimer()
    this.clearElapsedTimer()
    // 先离开 recognizing，避免后续 setData 竞态仍停在转圈
    const next = Object.assign({ pageLoading: false }, patch || {})
    if (!next.state) next.state = 'preview'
    this.setData(next)
  },

  startRecognize(tempPath) {
    const token = ++this.recognizeToken
    this.clearRecognizeTimer()
    this.startElapsedTimer()

    this.setData({
      state: 'recognizing',
      tempPath,
      result: null,
      failMessage: '',
      failCode: '',
      timingSteps: [],
      timingTotalText: ''
    })

    const mode = resolveMode()
    this.recognizeTimer = setTimeout(() => {
      const elapsed = Date.now() - (this.mattingStartedAt || Date.now())
      this.finishRecognize(token, {
        state: 'fail',
        failCode: 'TIMEOUT',
        failMessage: RECOGNITION_ENABLED ? '识别超时，请重试' : '抠图超时，请重试',
        timingElapsedText: `已用时 ${(elapsed / 1000).toFixed(1)}s`,
        timingTotalText: `总耗时 ${formatMs(elapsed)}`,
        timingSteps: this.data.timingSteps || []
      })
    }, timeoutForMode(mode))

    const applyResult = (result) => {
      if (token !== this.recognizeToken) return
      const elapsed = Date.now() - (this.mattingStartedAt || Date.now())
      const timingView = buildTimingView(result && result.timing, elapsed)

      if (!result || !result.ok) {
        const code = (result && result.code) || 'MATTING_FAILED'
        let failMessage = (result && result.message) || '处理失败，请重试'
        if (code === 'NO_CAT') failMessage = copy.tips.noCat || '找不到猫咪'
        if (code === 'HEAD_ONLY') failMessage = (result && result.message) || copy.tips.headOnly
        if (code === 'TOO_FAR') failMessage = (result && result.message) || copy.tips.tooFar
        if (code === 'TIMEOUT') failMessage = RECOGNITION_ENABLED ? '识别超时，请重试' : '抠图超时，请重试'
        if (code === 'MATTING_FAILED' || code === 'REMBG_UNREACHABLE') {
          failMessage = (result && result.message) || '抠图失败，请换一张清晰全身照'
        }

        this.finishRecognize(token, {
          state: 'fail',
          failCode: code,
          failMessage,
          timingSteps: timingView.steps,
          timingTotalText: timingView.totalText || `总耗时 ${formatMs(elapsed)}`,
          timingElapsedText: `已用时 ${(elapsed / 1000).toFixed(1)}s`
        })
        return
      }

      // 快模型没把握：先给用户看原图（压暗+角标），后台精修完再换成贴纸
      const refining = !!(result.needsRefine && typeof result.refine === 'function')
      this.finishRecognize(token, {
        state: 'preview',
        stampDate: stampDateText(),
        timingSteps: timingView.steps,
        timingTotalText: timingView.totalText || `总耗时 ${formatMs(elapsed)}`,
        timingElapsedText: `已用时 ${(elapsed / 1000).toFixed(1)}s`,
        result: {
          breed: result.breed || (RECOGNITION_ENABLED ? '中华田园猫' : '待识别'),
          confidence: result.confidence || 0,
          hint:
            result.hint ||
            (RECOGNITION_ENABLED
              ? `识别置信度 ${result.confidence || 0}%`
              : '暂未识别品种，仅抠图预览'),
          mattingFailed: !!result.mattingFailed,
          cutoutPath: refining ? tempPath : result.cutoutPath || tempPath,
          originalPath: result.originalPath || tempPath,
          provider: result.provider || '',
          refining,
          popSeq: 0,
          refining,
          timing: timingView.lines,
          timingTotalText: timingView.totalText || `总耗时 ${formatMs(elapsed)}`
        }
      })
      if (refining) this.startRefine(token, result.refine, result.cutoutPath)
      this._startCatMatch(token, result.cutoutPath)
    }

    setTimeout(() => {
      // 开识别：先 rembg 出预览（结束 loading），再百度识品种。
      // 禁止与 rembg 并行共用 mattingCanvas，否则抠图日志已出仍会卡在 recognizing。
      if (RECOGNITION_ENABLED) {
        const totalStart = Date.now()
        const timing = []

        makeStickerWithCloudMatting(tempPath, {
          canvas: this.mattingCanvas,
          forceRembgFull: true
        })
          .then((sticker) => {
            if (token !== this.recognizeToken) return
            const rembgMs = Date.now() - totalStart
            if (sticker && Array.isArray(sticker.timing)) timing.push(...sticker.timing)
            timing.push(`整图rembg: ${rembgMs}ms`)
            console.log('[camera] rembg done → preview', rembgMs, 'ms', sticker && sticker.ok)

            if (
              sticker &&
              !sticker.ok &&
              (sticker.code === 'REMBG_UNREACHABLE' || sticker.code === 'TIMEOUT')
            ) {
              applyResult({
                ok: false,
                code: sticker.code || 'MATTING_FAILED',
                message:
                  sticker.message ||
                  '本机 rembg 失败，请确认已启动 7000 与 7001 代理',
                timing
              })
              return
            }

            const cutoutPath = (sticker && sticker.cutoutPath) || tempPath
            // 立刻结束转圈；品种稍后回填
            applyResult({
              ok: true,
              breed: '识别中…',
              confidence: 0,
              mattingFailed: !sticker || !sticker.ok || cutoutPath === tempPath,
              cutoutPath,
              originalPath: tempPath,
              needsRefine: !!(sticker && sticker.needsRefine),
              refine: sticker && sticker.refine,
              provider: (sticker && sticker.provider) || 'rembg-local',
              hint: '贴纸已出，百度品种识别中…',
              timing: timing.concat([`总耗时(抠图): ${rembgMs}ms`])
            })

            const breedStart = Date.now()
            // 不用页面 canvas，避免和抠图抢同一块 2d 节点
            api
              .recognizeBreedOnly({ filePath: tempPath })
              .then((cloud) => {
                if (token !== this.recognizeToken) return
                if (this.data.state !== 'preview' || !this.data.result) return

                // 用户已手动选品种：晚到的识别结果只回填 recognizedBreed，不覆盖手选
                const manual = !!this.data.result.breedManual
                const petType = String((cloud && cloud.petType) || '')
                if (cloud && cloud.ok === false && petType && petType !== 'cat') {
                  // 贴纸已出：非猫只改文案，不再打回 loading/失败页
                  this.setData({
                    ...(manual ? {} : { 'result.breed': '待识别' }),
                    'result.hint': cloud.message || '未识别为猫，可点编辑改名'
                  })
                  return
                }

                const recognized = !!(cloud && cloud.ok)
                const breed = recognized
                  ? cloud.breed
                  : (cloud && cloud.breed) || '待识别'
                const confidence = recognized
                  ? cloud.confidence || 0
                  : Number(cloud && cloud.confidence) || 0
                const provider = (cloud && cloud.provider) || 'baidu'
                const breedMs = Date.now() - breedStart
                const steps = (this.data.timingSteps || []).slice()
                steps.push({ text: `百度品种识别: ${breedMs}ms` })
                this.setData({
                  timingSteps: steps,
                  ...(manual ? {} : { 'result.breed': breed }),
                  'result.recognizedBreed': recognized ? breed : '',
                  'result.confidence': confidence,
                  'result.hint': recognized
                    ? `百度识别 · 置信度 ${confidence}%`
                    : '未识别到品种，可点编辑改名',
                  'result.provider': `${provider}+rembg`
                })
              })
              .catch((e) => {
                console.warn('[camera] breed only fail', e)
                if (token !== this.recognizeToken) return
                if (this.data.state !== 'preview' || !this.data.result) return
                this.setData({
                  ...(this.data.result.breedManual ? {} : { 'result.breed': '待识别' }),
                  'result.recognizedBreed': '',
                  'result.hint': '品种识别失败，可点编辑改名'
                })
              })
          })
          .catch((e) => {
            console.warn('[camera] rembg error', e)
            applyResult({
              ok: false,
              code: (e && e.code) || 'MATTING_FAILED',
              message: (e && e.message) || '处理失败，请重试',
              timing: [`总耗时: ${Date.now() - totalStart}ms`]
            })
          })
        return
      }

      const run = (async () => {
        // 贴纸模式：极速/精抠都先腾讯取框再裁（极速无框时粗抠会糊）
        const mode = resolveMode()
        const mattingOpts = { canvas: this.mattingCanvas }
        const timing = []
        const totalStart = Date.now()
        if (mode === 'quality' || mode === 'lite') {
          try {
            const tDetect = Date.now()
            const box = await api.detectPetBox({
              filePath: tempPath,
              canvas: this.mattingCanvas
            })
            timing.push(
              `0.检测框: ${Date.now() - tDetect}ms${box && box.location ? '' : '(无框)'}`
            )
            if (box && box.location) {
              mattingOpts.location = box.location
              mattingOpts.detectWidth = box.detectWidth
              mattingOpts.detectHeight = box.detectHeight
            }
          } catch (e) {
            console.warn('[camera] detectPetBox skip', e)
            timing.push('0.检测框: 失败')
          }
        }
        const sticker = await makeStickerWithCloudMatting(tempPath, mattingOpts)
        if (sticker && Array.isArray(sticker.timing)) timing.push(...sticker.timing)
        const hasTotal = timing.some((t) => /总耗时/.test(String(t)))
        if (!hasTotal) timing.push(`总耗时: ${Date.now() - totalStart}ms`)

        const modeNow = resolveMode()
        if (
          sticker &&
          !sticker.ok &&
          (modeNow === 'rembg' || modeNow === 'quality') &&
          (sticker.code === 'REMBG_UNREACHABLE' || sticker.code === 'TIMEOUT')
        ) {
          return {
            ok: false,
            code: sticker.code || 'MATTING_FAILED',
            message:
              sticker.message ||
              '本机 rembg 失败，请确认已启动 7000 与 7001 代理',
            timing
          }
        }
        if (sticker && sticker.ok && sticker.cutoutPath) {
          return {
            ok: true,
            breed: '待识别',
            confidence: 0,
            mattingFailed: sticker.cutoutPath === tempPath,
            cutoutPath: sticker.cutoutPath,
            originalPath: tempPath,
            needsRefine: !!sticker.needsRefine,
            refine: sticker.refine,
            provider: sticker.provider || 'matting',
            hint:
              sticker.hint ||
              (sticker.cutoutPath === tempPath ? '抠图未完成，已用原图预览' : ''),
            timing
          }
        }
        if (sticker && sticker.ok && sticker.cutoutPath === tempPath) {
          console.warn('[camera] cutout equals original, treat as fail', sticker)
        }
        console.warn('[camera] matting incomplete', sticker)
        return {
          ok: true,
          breed: '待识别',
          confidence: 0,
          mattingFailed: true,
          cutoutPath: (sticker && sticker.cutoutPath) || tempPath,
          originalPath: tempPath,
          provider: (sticker && sticker.provider) || 'matting',
          hint: (sticker && sticker.message) || '抠图未完成，已用原图预览',
          timing
        }
      })()

      Promise.resolve()
        .then(() => run)
        .then(applyResult)
        .catch((e) => {
          console.warn('[camera] process error', e)
          applyResult({
            ok: false,
            code: (e && e.code) || 'MATTING_FAILED',
            message: (e && e.message) || '处理失败，请重试',
            timing: [`总耗时: ${Date.now() - (this.mattingStartedAt || Date.now())}ms`]
          })
        })
    }, 50)
  },

  /**
   * 后台精修：不阻塞界面。完成后把预览换成精修贴纸；失败则退回快模型结果。
   * this._refinePromise 供保存时等待。
   */
  startRefine(token, refine, quickCutoutPath) {
    const started = Date.now()
    this._quickCutout = quickCutoutPath || ''
    this._refinePromise = Promise.resolve()
      .then(() => refine())
      .catch((e) => ({ ok: false, message: (e && e.message) || '精细抠图失败' }))
      .then((r) => {
        if (token !== this.recognizeToken || !this.data.result) return
        const steps = (this.data.timingSteps || []).slice()
        if (r && r.ok && r.cutoutPath) {
          steps.push({ text: `后台精修(${r.model || 'refine'}): ${Date.now() - started}ms` })
          this.setData({
            timingSteps: steps,
            'result.cutoutPath': r.cutoutPath,
            'result.mattingFailed': false,
            'result.refining': false,
            'result.popSeq': ((this.data.result && this.data.result.popSeq) || 0) + 1
          })
        } else {
          steps.push({ text: `后台精修失败: ${(r && r.message) || ''}` })
          this.setData({
            timingSteps: steps,
            'result.cutoutPath': quickCutoutPath || this.data.tempPath,
            'result.refining': false,
            'result.popSeq': ((this.data.result && this.data.result.popSeq) || 0) + 1,
            'result.hint': '精细抠图失败，已用快速结果'
          })
        }
      })
      .finally(() => {
        if (token === this.recognizeToken) this._refinePromise = null
      })
  },

  /** 保存前：精修还没完就等它（最多 30s，超时用当前预览） */
  async waitRefineIfNeeded() {
    if (!this._refinePromise || !(this.data.result && this.data.result.refining)) return
    wx.showLoading({ title: '精细抠图中…', mask: true })
    await Promise.race([this._refinePromise, new Promise((r) => setTimeout(r, 30000))])
    wx.hideLoading()
    if (this.data.result && this.data.result.refining) {
      // 超时仍未完成：用快模型结果保存，别把原图当贴纸存下
      this.setData({
        'result.refining': false,
        'result.cutoutPath': this._quickCutout || this.data.result.cutoutPath
      })
    }
  },

  onRetake() {
    if (this._saving) return
    this._refinePromise = null
    this._catMatch = null
    this.recognizeToken += 1
    this.clearRecognizeTimer()
    this.clearElapsedTimer()
    this.setData({
      state: 'ready',
      tempPath: '',
      result: null,
      note: '',
      placeText: '',
      geo: null,
      showNoteModal: false,
      showPlaceModal: false,
      checkingMatches: false,
      catMatches: [],
      timingElapsedText: '',
      timingSteps: [],
      timingTotalText: ''
    })
  },

  onRetryRecognize() {
    if (!this.data.tempPath) {
      this.onRetake()
      return
    }
    this.startRecognize(this.data.tempPath)
  },

  onBackHome() {
    nav.switchTab(this, '/pages/home/home')
  },

  _startCatMatch(token, quickCutout) {
    if (this._catMatch && this._catMatch.token === token) return this._catMatch.promise
    const r = this.data.result
    const original = r.originalPath || this.data.tempPath
    const cutout = quickCutout || r.cutoutPath
    const promise = findCatMatches({ original, cutout: !r.mattingFailed && cutout !== original ? cutout : '' }, {
      canvas: this.identityCanvas,
      page: this,
      isCurrent: () => token === this.recognizeToken
    }).catch((err) => {
      console.warn('[camera] cat matching failed', err)
      return { identity: null, matches: [] }
    })
    this._catMatch = { token, promise, identity: null }
    return promise
  },

  async onSaveStart() {
    const { state, result, checkingMatches, catMatches, showNoteModal, showPlaceModal } = this.data
    if (state !== 'preview' || !result || this._saving || checkingMatches || catMatches.length || showNoteModal || showPlaceModal) return
    const token = this.recognizeToken
    this.setData({ checkingMatches: true })
    const { identity, matches } = await this._startCatMatch(token)
    if (token !== this.recognizeToken) return
    this._catMatch.identity = identity
    const exact = matches.find((match) => match.exact)
    if (exact) {
      wx.redirectTo({
        url: '/pages/card-detail/card-detail?id=' + encodeURIComponent(exact.id),
        fail: () => {
          if (token !== this.recognizeToken) return
          this.setData({ checkingMatches: false })
          wx.showToast({ title: '猫卡打开失败，请重试', icon: 'none' })
        }
      })
      return
    }
    this.setData({ checkingMatches: false, catMatches: matches })
    if (!matches.length) this.onAddNewCat()
  },

  onCloseCatMatches() {
    if (!this._saving) this.setData({ catMatches: [] })
  },

  onAddNewCat() {
    if (!this._saving) this.setData({ catMatches: [], showNoteModal: true, note: '' })
  },

  async onSaveCatMemory(e) {
    const cardId = e.currentTarget.dataset.id
    const r = this.data.result
    if (this._saving || !r || !this.data.catMatches.some((match) => match.id === cardId)) return
    this._saving = true
    this.setData({ saving: true })
    try {
      await api.createMemory({
        cardId,
        imagePath: r.originalPath || this.data.tempPath,
        photoIdentity: this._catMatch && this._catMatch.identity
      })
    } catch (err) {
      this._saving = false
      if (this.__mxhUnloaded) return
      this.setData({ saving: false })
      wx.showToast({ title: (err && err.message) || '保存失败，请重试', icon: 'none' })
      return
    }
    this._saving = false
    if (this.__mxhUnloaded) return
    this.setData({ saving: false, catMatches: [] })
    wx.showToast({ title: '已存入记忆', icon: 'success' })
    nav.redirectTo(this, '/pages/card-detail/card-detail?id=' + encodeURIComponent(cardId))
  },

  onNoteInput(e) {
    this.setData({ note: e.detail.value })
  },

  onNoteSkip() {
    this.openPlaceStep(this.data.note || '')
  },

  onNoteSave(e) {
    this.openPlaceStep((e && e.detail && e.detail.value) || '')
  },

  openPlaceStep(note) {
    this.setData({
      showNoteModal: false,
      note: note || '',
      showPlaceModal: true,
      placeText: '',
      geo: null,
      locating: true,
      locationHint: copy.tips.locating,
      showLocationAuth: false
    })
    this.ensureGeo()
  },

  async ensureGeo() {
    this.setData({ locating: true, locationHint: copy.tips.locating })
    const token = this.recognizeToken
    const loc = await getCurrentPosition()
    if (token !== this.recognizeToken || !this.data.showPlaceModal) return false
    if (!loc) {
      this.setData({
        locating: false,
        geo: null,
        locationHint: copy.tips.locationRequired,
        showLocationAuth: true
      })
      return false
    }
    const geo = blurCoordinate(loc.latitude, loc.longitude)
    const customPlace = (this.data.placeText || '').trim()
    this.setData({
      geo,
      locating: false,
      locationHint: copy.tips.locationReady,
      // 没填地点就留空（输入框会显示占位提示），别把提示语当地名存下来
      placeText: customPlace === copy.tips.locationReady ? '' : customPlace,
      showLocationAuth: false
    })
    return true
  },

  onPlaceInput(e) {
    this.setData({ placeText: e.detail.value })
  },

  onPlaceCancel() {
    this.setData({ showPlaceModal: false, locating: false })
  },

  async onPlaceDone(e) {
    if (!this.data.showPlaceModal || this._saving) return
    const placeText = ((e && e.detail && e.detail.value) || this.data.placeText || '').trim()
    this.setData({ placeText })
    if (!isValidGeo(this.data.geo)) {
      const ok = await this.ensureGeo()
      if (!ok) return
    }
    this.persistCard()
  },

  onUseLocation() {
    this.ensureGeo().then((ok) => {
      if (ok) wx.showToast({ title: copy.tips.locationReady, icon: 'none' })
    })
  },

  onEditBreed() {
    if (this.data.state !== 'preview' || !this.data.result) return
    this.setData({ showBreedPicker: true })
  },

  onBreedCancel() {
    this.setData({ showBreedPicker: false })
  },

  onPickBreed(e) {
    const breed = ((e && e.currentTarget && e.currentTarget.dataset.breed) || '').trim()
    if (!breed || !this.data.result) return
    this.setData({
      showBreedPicker: false,
      'result.breed': breed,
      'result.confidence': 100,
      'result.breedManual': true,
      'result.hint': '已手动选择品种'
    })
  },

  async persistCard() {
    // 同步锁：setData 是异步的，且下面要 await 定位，两次快速点击都会穿过 data.saving
    if (this._saving || this.data.saving || !this.data.result) return
    this._saving = true
    const token = this.recognizeToken
    if (!isValidGeo(this.data.geo)) {
      const ok = await this.ensureGeo()
      if (!ok) {
        this._saving = false
        if (token === this.recognizeToken) this.setData({ showPlaceModal: true })
        return
      }
    }

    this.setData({ saving: true, showPlaceModal: false })
    await this.waitRefineIfNeeded()
    if (token !== this.recognizeToken) return
    wx.showLoading({ title: '保存中', mask: true })

    const r = this.data.result
    // 识别还没回来就保存：别把占位文案「识别中…」当品种永久存下来
    const breedPending = r.breed === '识别中…'
    try {
      const { card } = await api.createCard({
        breed: breedPending ? '待识别' : r.breed,
        recognizedBreed: breedPending ? '' : r.recognizedBreed,
        breedManual: !!r.breedManual,
        confidence: r.confidence,
        mattingFailed: r.mattingFailed,
        cutoutPath: r.cutoutPath,
        originalPath: r.originalPath,
        shotAt: Date.now(),
        note: this.data.note,
        placeText: this.data.placeText,
        geo: this.data.geo,
        photoIdentity: this._catMatch && this._catMatch.identity
      })
      wx.hideLoading()
      this.setData({ saving: false })
      nav.redirectTo(this, `/pages/card-detail/card-detail?id=${card._id}`)
    } catch (err) {
      this._saving = false
      wx.hideLoading()
      this.setData({ saving: false })
      if (err && err.code === 'GEO_REQUIRED') {
        this.setData({ showPlaceModal: true, showLocationAuth: true })
        wx.showToast({ title: copy.tips.locationRequired, icon: 'none' })
        return
      }
      wx.showToast({ title: (err && err.message) || '保存失败，请重试', icon: 'none' })
    }
  }
})
