import { usePlayer } from '../store/player'

export function QueuePanel() {
  const queue = usePlayer((s) => s.queue)
  const items = queue?.queue ?? []

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      <div className="px-4 py-3 border-b border-neutral-800">
        <h3 className="text-xs font-semibold uppercase text-neutral-400 tracking-wider">
          Up next
        </h3>
        <p className="text-xs text-neutral-500">
          {items.length} queued
        </p>
      </div>
      {items.length === 0 ? (
        <p className="p-4 text-neutral-500 text-sm">Queue is empty.</p>
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
                className="px-4 py-2.5 border-b border-neutral-900"
              >
                <div className="text-sm truncate">{item.name}</div>
                <div className="text-xs text-neutral-500 truncate">{subtitle}</div>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
