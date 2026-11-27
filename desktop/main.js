/**
 * The desktop application.
 *
 * A native window that hosts the configuration page and owns the gateway in
 * the same process, so the user never has to run a server by hand.
 *
 * The window is deliberately thin: the page and its JSON API are the same
 * ones the CLI serves, which keeps one implementation instead of two.
 */
import { app, BrowserWindow, Menu, Tray, shell, nativeImage } from 'electron'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const UI_PORT = Number(process.env.WORKBUDDY_BRIDGE_UI_PORT ?? 4477)

let mainWindow = null
let tray = null
let bridge = null
/** Set when a second launch asked the running instance to show its window. */
let showRequested = false

/**
 * Only one instance may own the gateway ports.
 *
 * A second launch hands its request to the first one and exits, so the user
 * can double-click the shortcut as often as they like.
 */
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    showRequested = true
    revealWindow()
  })
}

/** Start the gateway and the local UI server. */
async function startBridge() {
  const { App } = await import('../src/app.js')
  const { loadConfig } = await import('../src/config/store.js')
  const { startUiServer } = await import('../src/ui/server.js')

  bridge = new App(loadConfig())
  const autoStart = await import('./autostart.js')
  bridge.setAutoStart({
    isEnabled: () => autoStart.isEnabled(),
    setEnabled: (on) => autoStart.setEnabled(on),
  })
  await bridge.startGateway()
  bridge.loadModels().catch(() => {})
  bridge.startCreditScheduler()
  bridge.uiServer = await startUiServer({ app: bridge, port: UI_PORT })
}

/** Create the main window. */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 860,
    minWidth: 860,
    minHeight: 640,
    show: false,
    title: 'WorkBuddy Bridge',
    backgroundColor: '#f6f7f5',
    autoHideMenuBar: false,
    icon: path.join(HERE, 'icons', 'icon-256.png'),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  mainWindow.loadURL(`http://127.0.0.1:${UI_PORT}/`)

  mainWindow.once('ready-to-show', () => {
    // `--hidden` is how the start-on-login entry launches the app: the
    // gateway comes up, but no window pops in the user's face.
    if (process.argv.includes('--hidden') && !showRequested) return
    mainWindow.show()
    if (showRequested) mainWindow.focus()
  })

  // Keep navigation inside the app; open real links in the browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`http://127.0.0.1:${UI_PORT}`)) {
      event.preventDefault()
      shell.openExternal(url)
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })
}

/** Bring the window up, creating it if needed. */
function revealWindow() {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.show()
    mainWindow.focus()
  } else {
    createWindow()
  }
}

/** A tray icon so the gateway keeps running when the window is closed. */
function createTray() {
  const icon = nativeImage.createFromPath(path.join(HERE, 'icons', 'icon-256.png'))
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon)
  tray.setToolTip('WorkBuddy Bridge')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '打开配置界面',
        click: revealWindow,
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => app.quit(),
      },
    ]),
  )
  tray.on('click', () => {
    if (mainWindow?.isVisible()) mainWindow.hide()
    else revealWindow()
  })
}

/** The application menu. */
function createMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '重新载入', click: () => mainWindow?.reload() },
        { type: 'separator' },
        { label: '退出', role: 'quit' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '打开日志目录',
          click: async () => {
            const { LOG_DIR } = await import('../src/config/paths.js')
            shell.openPath(LOG_DIR)
          },
        },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  try {
    await startBridge()
  } catch (error) {
    // The window still opens so the page can show what went wrong.
    console.error(`[desktop] bridge failed to start: ${error.message}`)
  }
  createWindow()
  createTray()
  createMenu()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Stay resident in the tray; the gateway has to keep serving.
})

app.on('before-quit', async () => {
  if (bridge) {
    try {
      await bridge.stop()
    } catch {
      /* ignore */
    }
  }
})
