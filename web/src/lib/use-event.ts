import { useCallback, useLayoutEffect, useRef } from 'react'

/** Stable event identity without retaining an old render's session or selection. */
export function useEvent<Args extends unknown[], Result>(callback: (...args: Args) => Result): (...args: Args) => Result {
  const ref = useRef(callback)
  useLayoutEffect(() => { ref.current = callback })
  return useCallback((...args: Args) => ref.current(...args), [])
}
