Component({
  options: { addGlobalClass: true },
  properties: {
    cardId: { type: String, value: '' },
    image: { type: String, value: '' },
    breed: { type: String, value: '' },
    date: { type: String, value: '' },
    place: { type: String, value: '' },
    memoryCount: { type: Number, value: 0 }
  },
  methods: {
    onTap() {
      this.triggerEvent('tapcard', { cardId: this.data.cardId })
    }
  }
})
