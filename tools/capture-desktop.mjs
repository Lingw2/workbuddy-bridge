/**
 * Screenshot the desktop window.
 *
 * Runs the real application code in an Electron window and captures the
 * page, which avoids the DPI virtualisation problems of screen-grabbing
 * tools on Windows.
 *
 *   npx electron tools/capture-desktop.mjs [output.png] [width] [height] [scrollToSelector]
 */
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')
const UI_PORT = Number(process.env.WORKBUDDY_BRIDGE_UI_PORT ?? 4477)

const [output = path.join(ROOT, 'docs', 'desktop-shot.png')] = process.argv.slice(2)
const width = Number(process.argv[3] ?? 1080)
const height = Number(process.argv[4] ?? 900)
const scrollTo = process.argv[5] ?? ''

app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width,
    height,
    show: false,
    backgroundColor: '#0d0f0e',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })

  await window.loadURL(`http://127.0.0.1:${UI_PORT}/`)
  // The page polls the state every few seconds; wait for it to fill in.
  await new Promise((resolve) => setTimeout(resolve, 6000))

  if (scrollTo) {
    await window.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(scrollTo)})?.scrollIntoView({block:'start'})`,
    )
    await new Promise((resolve) => setTimeout(resolve, 800))
  }

  const image = await window.capturePage()
  const { writeFileSync } = await import('node:fs')
  writeFileSync(output, image.toPNG())
  console.log(`wrote ${output}`)

  app.quit()
})
