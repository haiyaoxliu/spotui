import { useEffect, useRef } from 'react'

// Trailing element for paginated lists. Doubles as a button (explicit click)
// and an auto-trigger via IntersectionObserver — when the footer scrolls
// into view we fire onLoadMore once. The store's loadMore must be
// idempotent (no-op when already loading) since both paths can race.
export function LoadMoreFooter({
  loadingMore,
  hasMore,
  loadedCount,
  total,
  onLoadMore,
  className = '',
  label = 'Load more',
}: {
  loadingMore: boolean
  hasMore: boolean
  loadedCount: number
  total: number | null
  onLoadMore: () => void
  className?: string
  label?: string
}) {
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!hasMore || loadingMore) return
    const el = sentinelRef.current
    if (!el) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) onLoadMore()
      },
      // rootMargin pulls the trigger a bit before the footer is fully on
      // screen, so the next page is already on the wire by the time the
      // user reaches it.
      { rootMargin: '120px' },
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [hasMore, loadingMore, onLoadMore])

  if (!hasMore && !loadingMore) {
    if (total != null && loadedCount > 0) {
      return (
        <div className={`px-4 py-2 text-[11px] text-neutral-500 dark:text-neutral-600 ${className}`}>
          {loadedCount} of {total} loaded
        </div>
      )
    }
    return null
  }

  return (
    <div ref={sentinelRef} className={`px-4 py-2 ${className}`}>
      <button
        onClick={onLoadMore}
        disabled={loadingMore || !hasMore}
        className="w-full text-xs text-neutral-600 hover:text-neutral-800 dark:text-neutral-400 dark:hover:text-neutral-200 py-1 rounded border border-neutral-200 hover:border-neutral-300 dark:border-neutral-800 dark:hover:border-neutral-700 disabled:opacity-40 disabled:cursor-default"
      >
        {loadingMore
          ? 'Loading…'
          : total != null
            ? `${label} (${loadedCount} of ${total})`
            : label}
      </button>
    </div>
  )
}
