import React from 'react'
import ReactDOM from 'react-dom/client'
import { App } from './App'
import { startThemeSync } from './shell/theme-sync'
// Geist (Vercel) — bundled offline via @fontsource-variable, before styles.css so the
// @font-face rules (and their bundled woff2) are registered when the tokens reference them.
import '@fontsource-variable/geist'
import '@fontsource-variable/geist-mono'
import './styles.css'

async function mountApp(): Promise<void> {
  // Resolve and apply main's confirmed theme while the BrowserWindow is hidden.
  // The subscription is armed before the read, so a concurrent OS update wins.
  const stopThemeSync = await startThemeSync(window.api)
  window.addEventListener('beforeunload', stopThemeSync, { once: true })

  ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  )

  // Let React commit the themed shell before asking main to reveal the window.
  requestAnimationFrame(() => window.api.themeReady())
}

void mountApp().catch((error: unknown) => {
  console.error('[app] failed to mount:', error)
})
