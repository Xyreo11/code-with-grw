import { test, expect, type Page } from '@playwright/test'
import { execSync } from 'node:child_process'

/**
 * The happy path, through a real browser.
 *
 * One journey, covering the assignment's three minimums end to end: sign in,
 * see what changed since the cursor, understand why, acknowledge it, and watch
 * the brief change as a result. The unit tests prove the engine is correct;
 * this proves the correctness reaches the screen.
 *
 * Deliberately not exhaustive. Broad browser coverage of a product whose logic
 * is already covered by 130 unit tests would be slow to run and slower to
 * maintain, and would mostly re-test React.
 */

/** Reset the demo user to a known returning-user state before the journey. */
test.beforeAll(() => {
  execSync('npx tsx scripts/seed-demo.ts --days=75', { stdio: 'pipe' })
})

async function signIn(page: Page) {
  await page.goto('/login')
  await page.getByLabel('EMAIL').fill('demo@sitrep.local')
  await page.getByLabel('PASSWORD').fill('sitrep-demo')
  await page.getByRole('button', { name: 'Sign in' }).click()
  await expect(page.getByRole('heading', { level: 1 })).toContainText('Navika')
}

test('a returning user sees what changed, why, and can clear it', async ({
  page,
}) => {
  await signIn(page)

  // --- the brief exists and is framed by the cursor ------------------------
  await expect(page.getByText(/HERE'S WHAT CHANGED SINCE YOU LAST CHECKED/)).toBeVisible()
  await expect(page.getByText(/DAYS AGO/)).toBeVisible()

  const cards = page.locator('article')
  const cardCount = await cards.count()
  expect(cardCount).toBeGreaterThan(0)

  // The attention budget must actually cap the list, not just exist.
  expect(cardCount).toBeLessThanOrEqual(5)

  // --- the score is explained, in both directions --------------------------
  const first = cards.first()
  const symbol = (await first.locator('h3').first().innerText()).trim()

  await first.getByRole('button', { name: 'Why am I seeing this?' }).click()
  await expect(first.getByText('RANKED')).toBeVisible()
  await expect(first.getByText('WHY NOT HIGHER')).toBeVisible()

  // --- acknowledging removes it and promotes the next ----------------------
  // Wait for the write to land rather than racing it: the click handler is
  // async, so click() returns before the request completes.
  await Promise.all([
    page.waitForResponse(
      (r) => r.url().includes('/api/watch-state/mark-seen') && r.ok(),
    ),
    first.getByRole('button', { name: 'Mark seen' }).click(),
  ])

  // The card must stay gone across a full reload, not just optimistically in
  // local state - the cursor lives on the server.
  await page.reload()
  await expect(
    page.locator('article').filter({ has: page.getByRole('heading', { name: symbol, exact: true }) }),
  ).toHaveCount(0)

  // --- the product is honest about what it held back -----------------------
  await expect(
    page.getByText(/moved within (its|their) normal range/),
  ).toBeVisible()
})

test('the watchlist can be managed', async ({ page }) => {
  await signIn(page)
  await page.getByRole('link', { name: 'manage watchlist' }).click()

  await expect(page.getByRole('heading', { name: 'Manage your watchlist' })).toBeVisible()

  const rows = page.locator('li').filter({ has: page.locator('select') })
  const before = await rows.count()
  expect(before).toBeGreaterThan(0)

  // Priority is a real control, not decoration: it multiplies the score.
  const firstRow = rows.first()
  const symbol = (await firstRow.locator('span').first().innerText()).trim()
  await firstRow.locator('select').first().selectOption('HIGH')
  await page.reload()

  await expect(
    rows.filter({ hasText: symbol }).locator('select').first(),
  ).toHaveValue('HIGH')

  // Remove it, confirm the list shrank, then add it back.
  await rows.filter({ hasText: symbol }).getByRole('button', { name: 'Remove' }).click()
  await expect(rows).toHaveCount(before - 1)

  await page.getByRole('button', { name: `+ ${symbol}` }).click()
  await expect(rows).toHaveCount(before)
})

test('replay shows a theme forming, and refuses to invent one', async ({
  page,
}) => {
  await signIn(page)

  // The semiconductor window: a theme should form.
  await page.goto('/replay?s=semis-selloff')
  await expect(page.getByRole('heading', { name: /Watch the engine work/ })).toBeVisible()

  await page.getByRole('button', { name: /skip to next event/ }).click()
  await page.getByRole('button', { name: /skip to next event/ }).click()

  await expect(page.getByText('SEMICONDUCTORS THEME DETECTED')).toBeVisible()
  await expect(page.getByText(/rule: theme_led_market/)).toBeVisible()

  // The COVID window: everything falls, so NO sector theme may be reported.
  // This is the single most important behavioural claim in the product.
  await page.goto('/replay?s=covid-crash')

  for (let i = 0; i < 12; i++) {
    const skip = page.getByRole('button', { name: /skip to next event/ })
    if (!(await skip.isVisible().catch(() => false))) break
    await skip.click()
    await expect(page.getByText(/THEME DETECTED/)).toHaveCount(0)
  }
})

test('the pipeline page reports data quality and queue state', async ({
  page,
}) => {
  await signIn(page)
  await page.goto('/admin/pipeline')

  await expect(page.getByRole('heading', { name: 'Pipeline health' })).toBeVisible()
  // Headings specifically: "SOURCES" also appears as a table column header.
  await expect(page.getByRole('heading', { name: 'DATA QUALITY' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'QUEUES' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'SOURCES' })).toBeVisible()
})
