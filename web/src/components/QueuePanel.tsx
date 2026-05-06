import { usePlayer } from '../store/player'
import { useUI } from '../store/ui'

export function QueuePanel() {
  const queue = usePlayer((s) => s.queue)
  const detailLayout = useUI((s) => s.detailLayout)

  // Only surface tracks the user explicitly added via "Add to Queue".
  // Connect-state's `next_tracks` also bundles autoplay/context-
  // continuation entries, but those are noisy:
  //   - The active device often hasn't prefetched their metadata, so the
  //     names render blank.
  //   - For station/radio sessions Spotify flags everything as
  //     `autoplay`, including the user's own queued items, so the
  //     provider tag isn't a reliable filter for "really upcoming."
  //   - Mismatches against the iPhone's own queue surface have been
  //     observed; until we find the canonical queue endpoint we'd
  //     rather show nothing than something misleading.
  // Items without a `_provider` flag come from `/v1/me/player/queue`
  // (PKCE mode) — the public Web API doesn't tag entries, so we treat
  // those as user queue too.
  const items = queue?.queue ?? []
  const userQueue = items.filter(
    (it) => it._provider === undefined || it._provider === 'queue',
  )

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div
        className={
          'px-4 py-3 border-b border-neutral-200 dark:border-neutral-800 ' +
          (detailLayout === 'right' ? 'flex items-baseline gap-3' : '')
        }
      >
        <h3
          className={
            'text-xs font-semibold uppercase text-neutral-600 dark:text-neutral-400 tracking-wider ' +
            (detailLayout === 'right' ? 'flex-1 min-w-0 truncate' : '')
          }
        >
          Queue
        </h3>
        <p
          className={
            'text-xs text-neutral-600 dark:text-neutral-500 ' +
            (detailLayout === 'right' ? 'text-right' : '')
          }
        >
          {userQueue.length} queued
        </p>
      </div>
      {userQueue.length === 0 ? (
        <p className="p-4 text-neutral-600 dark:text-neutral-500 text-sm">
          Queue is empty.
        </p>
      ) : (
        <ul className="overflow-auto">
          {userQueue.map((item, idx) => {
            const subtitle =
              item.type === 'track'
                ? item.artists.map((a) => a.name).join(', ')
                : (item.show?.name ?? '')
            return (
              <li
                key={`${item.id}-${idx}`}
                className={
                  'px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-900 ' +
                  (detailLayout === 'right' ? 'flex items-center gap-3' : '')
                }
              >
                {detailLayout === 'right' ? (
                  <>
                    <div className="flex-1 min-w-0 text-sm truncate">{item.name}</div>
                    {subtitle && (
                      <span className="text-xs text-neutral-600 dark:text-neutral-500 truncate text-right max-w-[50%]">
                        {subtitle}
                      </span>
                    )}
                  </>
                ) : (
                  <>
                    <div className="text-sm truncate">{item.name}</div>
                    <div className="text-xs text-neutral-600 dark:text-neutral-500 truncate">
                      {subtitle}
                    </div>
                  </>
                )}
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
