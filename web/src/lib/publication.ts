import type { Publication } from '../types'

export function publicationURL(publication: Pick<Publication, 'public_id'>): string {
  const id = encodeURIComponent(publication.public_id)
  return /^[a-f0-9]{8}$/u.test(publication.public_id) ? `/${id}` : `/p/${id}`
}
