/// <reference lib="webworker" />
import { SearchIndex, type SearchRequest } from './search-index'

const index = new SearchIndex()
self.onmessage = (event: MessageEvent<SearchRequest>) => {
  const ids = index.apply(event.data)
  if (ids) self.postMessage({ id: event.data.id, ids })
}
