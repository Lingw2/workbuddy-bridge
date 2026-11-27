/**
 * Open a page in the user's browser.
 *
 * The desktop shell and the CLI both use this, so the login pages of the
 * third-party channels open in the normal browser window instead of inside
 * the tool.
 */
import { spawn } from 'node:child_process'

/**
 * @param {string} url
 * @returns {boolean} whether the browser was started
 */
export function openInBrowser(url) {
  if (!url) return false

  const command =
    process.platform === 'win32'
      ? { file: 'cmd', args: ['/c', 'start', '', url] }
      : process.platform === 'darwin'
        ? { file: 'open', args: [url] }
        : { file: 'xdg-open', args: [url] }

  try {
    const child = spawn(command.file, command.args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.unref()
    return true
  } catch {
    return false
  }
}
