Component({
  properties: {
    main: { type: String, value: '' },
    sub: { type: String, value: '' },
    buttonText: { type: String, value: '' }
  },
  methods: {
    onTap() {
      this.triggerEvent('action')
    }
  }
})
