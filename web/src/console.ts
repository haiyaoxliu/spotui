/**
 * Tiny shim that lets the data layer (api/*) surface operational messages
 * to the top console bar without importing React or the store directly at
 * call sites. Lives at the project root so api/* and components/* both
 * see it as a leaf dependency.
 */

import { useUI, type ConsoleLevel } from './store/ui'

export function notify(text: string, level: ConsoleLevel = 'info'): void {
  useUI.getState().pushConsoleMessage(text, level)
}
