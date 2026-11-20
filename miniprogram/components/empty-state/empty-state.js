Component({
  options: { addGlobalClass: true },
  properties: {
    main: { type: String, value: '' },
    sub: { type: String, value: '' },
    buttonText: { type: String, value: '' },
    // 空状态插画，默认用信封；页面可传 /assets/art/empty-*.svg
    illus: { type: String, value: '/assets/art/empty-mail.svg' }
  },
  methods: {
    onTap() {
      this.triggerEvent('action')
    }
  }
})
