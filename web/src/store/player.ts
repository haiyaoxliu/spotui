import { create } from 'zustand'
import type { Device, PlaybackState, Queue } from '../api/spotify'

interface PlayerState {
  playback: PlaybackState | null
  queue: Queue | null
  // Whether the currently playing track is in the user's Liked Songs.
  // null = unknown / not yet checked.
  liked: boolean | null

  setPlayback: (s: PlaybackState | null) => void
  setQueue: (q: Queue | null) => void
  setLiked: (l: boolean | null) => void

  // Optimistic mutations — applied instantly, corrected on next refresh.
  optimisticIsPlaying: (playing: boolean) => void
  patchPlayback: (patch: Partial<PlaybackState>) => void
  patchDevice: (patch: Partial<Device>) => void
}

export const usePlayer = create<PlayerState>((set) => ({
  playback: null,
  queue: null,
  liked: null,

  setPlayback: (playback) => set({ playback }),
  setQueue: (queue) => set({ queue }),
  setLiked: (liked) => set({ liked }),

  optimisticIsPlaying: (playing) =>
    set((s) =>
      s.playback ? { playback: { ...s.playback, is_playing: playing } } : s,
    ),
  patchPlayback: (patch) =>
    set((s) => (s.playback ? { playback: { ...s.playback, ...patch } } : s)),
  patchDevice: (patch) =>
    set((s) =>
      s.playback?.device
        ? {
            playback: {
              ...s.playback,
              device: { ...s.playback.device, ...patch },
            },
          }
        : s,
    ),
}))
