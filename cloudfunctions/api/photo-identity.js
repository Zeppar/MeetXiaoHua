const LIMIT = 4

function normalizePhotoIdentity(value) {
  if (!value || typeof value !== 'object') return null
  const digest = /^(sha1:[a-f0-9]{40}|md5:[a-f0-9]{32})$/.test(value.digest) ? value.digest : ''
  const photo = /^[a-f0-9]{16}$/.test(value.photo) ? value.photo : ''
  const foreground = /^[a-f0-9]{16}$/.test(value.foreground) ? value.foreground : ''
  const color = /^[a-f0-9]{12}$/.test(value.color) ? value.color : ''
  const embedding = /^[A-Za-z0-9+/]{512}$/.test(value.embedding) ? value.embedding : ''
  return digest || photo || foreground || embedding ? { digest, photo, foreground, color, embedding } : null
}

function appendIdentity(refs, identity) {
  const previous = Array.isArray(refs) ? refs : []
  if (!identity) return previous
  const remaining = previous.filter((ref) => identity.digest
    ? ref.digest !== identity.digest
    : !(identity.photo && ref.photo === identity.photo && ref.foreground === identity.foreground))
  if (remaining.length >= LIMIT) remaining.splice(1, remaining.length - LIMIT + 1)
  return [...remaining, identity]
}

module.exports = { normalizePhotoIdentity, appendIdentity }
