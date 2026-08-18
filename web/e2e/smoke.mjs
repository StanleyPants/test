/**
 * End-to-end smoke test: drives the built webapp in Chromium against a running
 * JoyAI server (real or mock) using a synthetic camera, then asserts that
 * frames actually round-tripped and got painted.
 *
 *   python ../mock-server/server.py --port 8099 --static-dir dist
 *   npm run build && npm run e2e
 *
 * Env:
 *   E2E_URL         app URL           (default http://127.0.0.1:8099/)
 *   E2E_CHROMIUM    chromium binary   (default: Playwright's own download)
 *   E2E_SHOT        screenshot path   (default e2e/smoke.png)
 */
import { chromium } from 'playwright'

const URL = process.env.E2E_URL ?? 'http://127.0.0.1:8099/'
const SHOT = process.env.E2E_SHOT ?? 'e2e/smoke.png'

const browser = await chromium.launch({
  executablePath: process.env.E2E_CHROMIUM || undefined,
  args: [
    '--use-fake-device-for-media-stream',
    '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
  ],
})

const context = await browser.newContext({
  permissions: ['camera'],
  viewport: { width: 1500, height: 950 },
})
const page = await context.newPage()

const errors = []
page.on('console', (message) => {
  if (message.type() === 'error') errors.push(message.text())
})
page.on('pageerror', (error) => errors.push(`pageerror: ${error.message}`))

await page.goto(URL, { waitUntil: 'networkidle' })
await page.getByRole('button', { name: 'Connect' }).click()
await page.getByRole('button', { name: 'Use camera' }).click()
await page.waitForTimeout(1500)
await page.getByRole('button', { name: 'Start editing' }).click()
await page.waitForTimeout(6000)

const readStat = (label) =>
  page
    .locator('.stat', { has: page.locator('.stat-label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('.stat-value')
    .innerText()

const stats = {
  uplink: await readStat('Uplink'),
  downlink: await readStat('Downlink'),
  rtt: await readStat('RTT'),
  glassToGlass: await readStat('Glass-to-glass'),
  framesInOut: await readStat('Frames in/out'),
  dropped: await readStat('Dropped'),
}

// Sample the output canvas: a painted edit has many distinct colours, whereas
// a stalled pipeline leaves it blank or flat.
const canvas = await page.evaluate(() => {
  const element = document.querySelector('canvas')
  if (!element || !element.width) return { painted: false }
  const pixels = element.getContext('2d').getImageData(0, 0, element.width, element.height).data
  const colours = new Set()
  for (let i = 0; i < pixels.length; i += 4 * 997) {
    colours.add(`${pixels[i]},${pixels[i + 1]},${pixels[i + 2]}`)
  }
  return { painted: true, width: element.width, height: element.height, distinctColours: colours.size }
})

await page.screenshot({ path: SHOT })
await page.getByRole('button', { name: 'Stop', exact: true }).click()
await page.waitForTimeout(300)
await browser.close()

console.log(JSON.stringify({ stats, canvas, errors }, null, 2))

const failures = []
if (!canvas.painted) failures.push('output canvas was never painted')
if ((canvas.distinctColours ?? 0) <= 3) failures.push('output canvas looks blank')
if (parseFloat(stats.uplink) <= 2) failures.push(`uplink too low: ${stats.uplink}`)
if (parseFloat(stats.downlink) <= 2) failures.push(`downlink too low: ${stats.downlink}`)
if (errors.length) failures.push(`console errors: ${errors.join(' | ')}`)

if (failures.length) {
  console.error('FAIL\n - ' + failures.join('\n - '))
  process.exit(1)
}
console.log(`PASS (screenshot: ${SHOT})`)
