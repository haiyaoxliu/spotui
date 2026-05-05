import { NowPlaying } from './NowPlaying'
import { QueuePanel } from './QueuePanel'
import { TransportBar } from './TransportBar'
import type { Refresh } from '../commands'

export function RightPanel({
  showTransport,
  onAfterAction,
}: {
  showTransport: boolean
  onAfterAction: Refresh
}) {
  return (
    <aside className="border-l border-neutral-200 dark:border-neutral-800 bg-neutral-100/60 dark:bg-neutral-900/40 w-80 flex flex-col overflow-hidden">
      <NowPlaying />
      {showTransport && <TransportBar onAfterAction={onAfterAction} compact />}
      <QueuePanel />
    </aside>
  )
}
