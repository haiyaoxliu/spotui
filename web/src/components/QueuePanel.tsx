import { usePlayer } from '../store/player'
import { useUI } from '../store/ui'
import type { PlayingItem } from '../api/spotify'

// Cap the autoplay/context section so a 40+-track recommendation tail
// doesn't dominate the panel. The user-added queue is uncapped because
// they explicitly chose those rows.
const UP_NEXT_MAX = 12

export function QueuePanel() {
  const queue = usePlayer((s) => s.queue)
  const detailLayout = useUI((s) => s.detailLayout)

  const items = queue?.queue ?? []
  // Connect-state tags each upcoming track with `_provider`:
  //   - 'queue' = user-added (Add to Queue)
  //   - 'context'/'autoplay' = continuation of the active context
  //   - undefined = /v1/me/player/queue (PKCE mode), treat as user queue
  //     since the public API doesn't separate the two.
  const userQueue = items.filter(
    (it) => it._provider === undefined || it._provider === 'queue',
  )
  const upNext = items.filter(
    (it) => it._provider !== undefined && it._provider !== 'queue',
  )
  // Skip placeholders Spotify hasn't enriched yet — autoplay entries
  // arrive with empty metadata until the player prefetches them.
  const upNextRenderable = upNext.filter((it) => it.name && it.name.length > 0)

  const hasAnything = userQueue.length > 0 || upNextRenderable.length > 0

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
          Up next
        </h3>
        <p
          className={
            'text-xs text-neutral-600 dark:text-neutral-500 ' +
            (detailLayout === 'right' ? 'text-right' : '')
          }
        >
          {userQueue.length} queued
          {upNextRenderable.length > 0 && (
            <span className="ml-2 opacity-70">
              · +{upNextRenderable.length} up next
            </span>
          )}
        </p>
      </div>
      {!hasAnything ? (
        <p className="p-4 text-neutral-600 dark:text-neutral-500 text-sm">
          Queue is empty.
        </p>
      ) : (
        <div className="overflow-auto">
          {userQueue.length > 0 && (
            <Section title="Queue" detailLayout={detailLayout}>
              {userQueue.map((item, idx) => (
                <Row
                  key={`q-${item.id}-${idx}`}
                  item={item}
                  detailLayout={detailLayout}
                />
              ))}
            </Section>
          )}
          {upNextRenderable.length > 0 && (
            <Section
              title={upNextSectionTitle(queue?.autoplay_context_uri)}
              detailLayout={detailLayout}
              muted
            >
              {upNextRenderable.slice(0, UP_NEXT_MAX).map((item, idx) => (
                <Row
                  key={`n-${item.id}-${idx}`}
                  item={item}
                  detailLayout={detailLayout}
                  muted
                />
              ))}
              {upNextRenderable.length > UP_NEXT_MAX && (
                <li className="px-4 py-2 text-[11px] text-neutral-500 italic">
                  +{upNextRenderable.length - UP_NEXT_MAX} more upcoming
                </li>
              )}
            </Section>
          )}
        </div>
      )}
    </div>
  )
}

function Section({
  title,
  children,
  detailLayout,
  muted = false,
}: {
  title: string
  children: React.ReactNode
  detailLayout: 'below' | 'right'
  muted?: boolean
}) {
  return (
    <div>
      <div
        className={
          'px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider ' +
          (muted
            ? 'text-neutral-500'
            : 'text-neutral-700 dark:text-neutral-300')
        }
      >
        {title}
      </div>
      <ul className={detailLayout === 'right' ? '' : ''}>{children}</ul>
    </div>
  )
}

function Row({
  item,
  detailLayout,
  muted = false,
}: {
  item: PlayingItem
  detailLayout: 'below' | 'right'
  muted?: boolean
}) {
  const subtitle =
    item.type === 'track'
      ? item.artists.map((a) => a.name).join(', ')
      : (item.show?.name ?? '')
  return (
    <li
      className={
        'px-4 py-2.5 border-b border-neutral-100 dark:border-neutral-900 ' +
        (muted ? 'opacity-75 ' : '') +
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
}

function upNextSectionTitle(autoplayContextUri: string | undefined): string {
  // Best-effort label: prefer the active context's type as a noun.
  // We don't have its name here (would require another fetch), but the
  // type alone is enough to set expectations: "Up next from playlist"
  // vs "Up next (recommendations)" for autoplay-only sequences.
  if (!autoplayContextUri) return 'Up next'
  const parts = autoplayContextUri.split(':')
  const kind = parts.length >= 3 ? parts[parts.length - 2] : ''
  if (kind === 'station') return 'Recommendations'
  if (kind === 'playlist') return 'Up next from playlist'
  if (kind === 'album') return 'Up next from album'
  if (kind === 'artist') return 'Up next from artist'
  if (kind === 'show') return 'Up next from show'
  return 'Up next'
}
