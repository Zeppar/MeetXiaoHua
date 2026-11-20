Component({
  properties: {
    show: { type: Boolean, value: false },
    title: { type: String, value: '' },
    desc: { type: String, value: '' },
    placeholder: { type: String, value: '' },
    value: { type: String, value: '' },
    maxlength: { type: Number, value: 100 },
    mode: { type: String, value: 'textarea' },
    cancelText: { type: String, value: '跳过' },
    confirmText: { type: String, value: '保存' },
    extra: { type: String, value: '' }
  },

  methods: {
    noop() {},

    onInput(e) {
      this.setData({ value: e.detail.value })
      this.triggerEvent('input', { value: e.detail.value })
    },
    onCancel() {
      this.triggerEvent('cancel', { value: this.data.value })
    },
    onConfirm() {
      this.triggerEvent('confirm', { value: this.data.value })
    },
    onExtra() {
      this.triggerEvent('extra')
    }
  }
})
