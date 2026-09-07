import MiniSearch from 'minisearch'

export interface SearchDocument { id: string; title: string; content: string; folder: string }
export type SearchRequest = { upsert?: SearchDocument[]; remove?: string[]; query?: string; id?: number }

export class SearchIndex {
  private readonly index = new MiniSearch<SearchDocument>({ fields: ['title', 'content', 'folder'] })
  apply(request: SearchRequest): string[] | undefined {
    for (const id of request.remove ?? []) if (this.index.has(id)) this.index.discard(id)
    for (const document of request.upsert ?? []) {
      if (this.index.has(document.id)) this.index.replace(document)
      else this.index.add(document)
    }
    return request.query === undefined ? undefined : this.index.search(request.query, { prefix: true, fuzzy: .2 }).map((result) => String(result.id))
  }
}
