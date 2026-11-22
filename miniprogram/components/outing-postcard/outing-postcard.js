Component({
  properties: {
    postcard: { type: Object, value: null }
  },

  data: { brokenCatImage: '', brokenFriendImage: '' },

  methods: {
    onCatImageError(e) {
      this.setData({ brokenCatImage: e.currentTarget.dataset.src })
    },

    onFriendImageError(e) {
      this.setData({ brokenFriendImage: e.currentTarget.dataset.src })
    }
  }
})
