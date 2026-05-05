import { usePlayer } from '../store/player'
import { useUI } from '../store/ui'

export function QueuePanel() {
  const queue = usePlayer((s) => s.queue)
  const items = queue?.queue ?? []
  const detailLayout = useUI((s) => s.detailLayout)

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
          {items.length} queued
        </p>
      </div>
      {items.length === 0 ? (
        <p className="p-4 text-neutral-600 dark:text-neutral-500 text-sm">Queue is empty.</p>
      ) : (
        <ul className="overflow-auto">
          {items.map((item, idx) => {
            const subtitle =
              item.type === 'track'
                ? item.artists.map((a) => a.name).join(', ')
                : item.show?.name ?? ''
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
                    <div className="text-xs text-neutral-600 dark:text-neutral-500 truncate">{subtitle}</div>
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
