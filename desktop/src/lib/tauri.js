// Every Tauri call goes through here so the UI also runs in a plain browser (`npm run dev`
// against `har serve`), where desktop-only features are simply absent.
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

export const isDesktop = () => Boolean(window.__TAURI_INTERNALS__)

export function desktopInvoke(command, args) {
  if (!isDesktop()) return Promise.reject(new Error('Only available in the HAR desktop app'))
  return invoke(command, args)
}

// Returns an unsubscribe function, usable directly as an effect cleanup.
export function desktopListen(event, handler) {
  if (!isDesktop()) return () => {}
  const pending = listen(event, handler)
  return () => { pending.then((stop) => stop()) }
}
