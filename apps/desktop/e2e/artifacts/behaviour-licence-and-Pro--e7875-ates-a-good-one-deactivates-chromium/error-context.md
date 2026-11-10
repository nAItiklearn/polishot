# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: behaviour.spec.ts >> licence and Pro >> rejects a bad key with a reason, activates a good one, deactivates
- Location: e2e\behaviour.spec.ts:227:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByText('Updates until')
Expected: visible
Error: strict mode violation: getByText('Updates until') resolved to 2 elements:
    1) <p class="pv-license-sub">Personal license, updates until November 9, 2027</p> aka getByText('Personal license, updates')
    2) <dt>Updates until</dt> aka getByText('Updates until', { exact: true })

Call log:
  - Expect "toBeVisible" getByText('Updates until') with timeout 10000ms
  - waiting for getByText('Updates until')

```

# Page snapshot

```yaml
- generic [ref=e3]:
  - banner [ref=e4]:
    - generic [ref=e5]: Polishot
    - button "Open command palette" [ref=e7] [cursor=pointer]:
      - generic [ref=e10]: Search commands
      - generic [ref=e11]:
        - generic [ref=e12]: Ctrl
        - generic [ref=e13]: K
    - generic [ref=e14]:
      - button "History" [ref=e15] [cursor=pointer]:
        - generic [aria-hidden]:
          - text: History
          - generic:
            - generic: Ctrl
            - generic: H
      - button "Settings" [ref=e19] [cursor=pointer]:
        - generic [aria-hidden]:
          - text: Settings
          - generic:
            - generic: Ctrl
            - generic: ","
      - 'button "License: Pro. Open license." [pressed] [ref=e23] [cursor=pointer]': Pro
    - generic [ref=e24]:
      - button "Minimize" [ref=e25]
      - button "Maximize" [ref=e27]
      - button "Close to tray" [ref=e30]
  - main [ref=e33]:
    - generic [ref=e34]:
      - generic [ref=e35]:
        - button "Back to the editor" [ref=e36] [cursor=pointer]:
          - generic [aria-hidden]:
            - text: Back to the editor
            - generic: Esc
        - heading "License" [level=1] [ref=e39]
      - generic [ref=e41]:
        - region "License status" [ref=e42]:
          - generic [ref=e44]:
            - paragraph [ref=e45]: Pro
            - paragraph [ref=e46]: Personal license, updates until November 9, 2027
          - generic [ref=e47]:
            - generic [ref=e48]:
              - term [ref=e49]: Edition
              - definition [ref=e50]: Personal
            - generic [ref=e51]:
              - term [ref=e52]: Issued
              - definition [ref=e53]: November 9, 2026
            - generic [ref=e54]:
              - term [ref=e55]: Updates until
              - definition [ref=e56]: November 9, 2027
            - generic [ref=e57]:
              - term [ref=e58]: Key ID
              - definition [ref=e59]: a3f9c20e71b4d5e8
          - button "Deactivate on this computer" [ref=e61] [cursor=pointer]
        - region "What each edition includes" [ref=e62]:
          - generic [ref=e63]:
            - heading "Free" [level=2] [ref=e64]
            - list [ref=e65]:
              - listitem [ref=e66]: Every capture, edit, redaction and export feature
              - listitem [ref=e67]: A small watermark on exports
              - listitem [ref=e68]: Up to 3 saved looks
          - generic [ref=e69]:
            - heading "Pro" [level=2] [ref=e70]
            - list [ref=e71]:
              - listitem [ref=e72]: No watermark on exports
              - listitem [ref=e73]: Your own logo or text instead of ours
              - listitem [ref=e74]: Unlimited saved looks
              - listitem [ref=e75]: Unlimited batch beautify
              - listitem [ref=e76]: One year of updates
  - region "Notifications"
```

# Test source

```ts
  138 | test.describe('history', () => {
  139 |   test('opens a past capture to re-edit and saves edits back', async ({ page }) => {
  140 |     await ready(page);
  141 |     await page.getByRole('button', { name: 'Hide' }).click(); // an edit worth saving
  142 |     await page.waitForTimeout(1800); // autosave
  143 |     expect((await last(page)).historySaves.length).toBeGreaterThan(0);
  144 |     await page.keyboard.press('Control+h');
  145 |     const card = page.locator('.pv-hcard-open').first();
  146 |     await expect(card).toBeVisible();
  147 |     await card.click();
  148 |     await expect(page.locator('.pv-inspector')).toBeVisible();
  149 |   });
  150 | 
  151 |   test('deletes one without asking, and clears all only after confirming', async ({ page }) => {
  152 |     await ready(page, 'history=3');
  153 |     await page.keyboard.press('Control+h');
  154 |     await expect(page.locator('.pv-hcard')).toHaveCount(4); // 3 seeded + the current capture
  155 |     await page.locator('.pv-hcard').first().hover();
  156 |     await page.locator('.pv-hcard').first().getByRole('button', { name: /Delete/ }).click();
  157 |     await expect(page.locator('.pv-hcard')).toHaveCount(3);
  158 |     await page.getByRole('button', { name: 'Clear all' }).click();
  159 |     const dialog = page.getByRole('alertdialog');
  160 |     await expect(dialog).toBeVisible();
  161 |     await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused(); // safe default
  162 |     await page.keyboard.press('Escape');
  163 |     await expect(page.locator('.pv-hcard')).toHaveCount(3); // cancelled
  164 |     await page.getByRole('button', { name: 'Clear all' }).click();
  165 |     await dialog.getByRole('button', { name: 'Clear all' }).click();
  166 |     await expect(page.getByText('Your captures will appear here.')).toBeVisible();
  167 |   });
  168 | 
  169 |   test('searches the recognised text', async ({ page }) => {
  170 |     await ready(page);
  171 |     await page.keyboard.press('Control+h');
  172 |     await page.getByRole('searchbox').fill('upstream');
  173 |     await expect(page.locator('.pv-hcard')).toHaveCount(1);
  174 |   });
  175 | });
  176 | 
  177 | test.describe('settings', () => {
  178 |   test('records a shortcut and shows a conflict the backend reports', async ({ page }) => {
  179 |     await ready(page);
  180 |     await page.keyboard.press('Control+,');
  181 |     const capture = page.getByRole('button', { name: /^Capture shortcut/ });
  182 |     await capture.click();
  183 |     await page.keyboard.press('Control+Shift+4'); // the mock says another app owns this one
  184 |     await expect(page.getByRole('alert').filter({ hasText: /already in use by another application/ })).toBeVisible();
  185 |     await expect(capture).toContainText('2'); // the old shortcut stayed
  186 | 
  187 |     await capture.click();
  188 |     await page.keyboard.press('Control+Alt+9');
  189 |     await expect(capture).toContainText('9');
  190 |     await expect(capture).toContainText('Alt');
  191 |   });
  192 | 
  193 |   test('a shortcut without a modifier is refused before it is sent', async ({ page }) => {
  194 |     await ready(page);
  195 |     await page.keyboard.press('Control+,');
  196 |     await page.getByRole('button', { name: /^Capture shortcut/ }).click();
  197 |     await page.keyboard.press('F9');
  198 |     await expect(page.getByRole('alert').filter({ hasText: /Ctrl, Alt or Shift/ })).toBeVisible();
  199 |   });
  200 | 
  201 |   test('optional shortcuts can be cleared with Backspace; Escape cancels recording', async ({ page }) => {
  202 |     await ready(page);
  203 |     await page.keyboard.press('Control+,');
  204 |     const scroll = page.getByRole('button', { name: /^Scrolling capture shortcut/ });
  205 |     await scroll.click();
  206 |     await page.keyboard.press('Control+Alt+s');
  207 |     await expect(scroll).toContainText('S');
  208 |     await scroll.click();
  209 |     await page.keyboard.press('Backspace');
  210 |     await expect(scroll).toContainText('Not set');
  211 |     await scroll.click();
  212 |     await page.keyboard.press('Escape');
  213 |     await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible(); // Esc cancelled recording, not the screen
  214 |   });
  215 | 
  216 |   test('theme and format changes apply immediately', async ({ page }) => {
  217 |     await ready(page);
  218 |     await page.keyboard.press('Control+,');
  219 |     await page.getByRole('radio', { name: 'Dark' }).click();
  220 |     await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  221 |     await page.getByRole('radio', { name: 'JPEG' }).click();
  222 |     await expect(page.getByRole('slider', { name: 'Quality' })).toBeEnabled();
  223 |   });
  224 | });
  225 | 
  226 | test.describe('licence and Pro', () => {
  227 |   test('rejects a bad key with a reason, activates a good one, deactivates', async ({ page }) => {
  228 |     await ready(page);
  229 |     await page.getByRole('button', { name: /License: Free/ }).click();
  230 |     const input = page.getByLabel('License key');
  231 |     await input.fill('hello');
  232 |     await page.getByRole('button', { name: 'Activate' }).click();
  233 |     await expect(page.getByRole('alert').filter({ hasText: /does not look like a license key/ })).toBeVisible();
  234 | 
  235 |     await input.fill('PSHOT-AAAAAA-BBBBBB');
  236 |     await page.getByRole('button', { name: 'Activate' }).click();
  237 |     await expect(page.getByRole('button', { name: /License: Pro/ })).toBeVisible();
> 238 |     await expect(page.getByText('Updates until')).toBeVisible();
      |                                                   ^ Error: expect(locator).toBeVisible() failed
  239 | 
  240 |     await page.getByRole('button', { name: 'Deactivate on this computer' }).click();
  241 |     await page.getByRole('alertdialog').getByRole('button', { name: 'Deactivate' }).click();
  242 |     await expect(page.getByRole('button', { name: /License: Free/ })).toBeVisible();
  243 |   });
  244 | 
  245 |   test('Free shows the watermark, Pro does not', async ({ page }) => {
  246 |     await ready(page);
  247 |     expect(await page.evaluate(() => (window as unknown as { __polishotApp: { editor: { licensed: boolean } } }).__polishotApp.editor.licensed)).toBe(false);
  248 |     await page.goto('/?mock=1&theme=light&delay=0&lic=pro');
  249 |     await expect(page.locator('.pv-inspector')).toBeVisible();
  250 |     await expect.poll(() => page.evaluate(() => (window as unknown as { __polishotApp: { editor: { licensed: boolean } } }).__polishotApp.editor.licensed)).toBe(true);
  251 |   });
  252 | 
  253 |   test('an expired key explains itself and the app stays Free', async ({ page }) => {
  254 |     await ready(page, 'lic=expired');
  255 |     expect(await page.evaluate(() => (window as unknown as { __polishotApp: { editor: { licensed: boolean } } }).__polishotApp.editor.licensed)).toBe(false);
  256 |     await page.getByRole('button', { name: /License: Free/ }).click();
  257 |     await expect(page.getByText(/Your license includes updates released until/)).toBeVisible();
  258 |   });
  259 | 
  260 |   test('Free allows 3 saved looks, then asks for Pro; Pro has no limit', async ({ page }) => {
  261 |     await ready(page);
  262 |     for (let i = 1; i <= 3; i++) {
  263 |       await page.getByPlaceholder('Name this look').fill(`Look ${i}`);
  264 |       await page.getByRole('button', { name: 'Save', exact: true }).last().click();
  265 |       await expect(page.getByRole('button', { name: `Look ${i}` })).toBeVisible();
  266 |     }
  267 |     await expect(page.getByPlaceholder('Name this look')).toHaveCount(0); // no field once the limit is reached
  268 |     await expect(page.getByText('You have saved all 3 looks that Free includes.')).toBeVisible();
  269 | 
  270 |     await page.goto('/?mock=1&theme=light&delay=0&lic=pro');
  271 |     await expect(page.locator('.pv-inspector')).toBeVisible();
  272 |     for (let i = 1; i <= 4; i++) {
  273 |       await page.getByPlaceholder('Name this look').fill(`Pro look ${i}`);
  274 |       await page.getByRole('button', { name: 'Save', exact: true }).last().click();
  275 |       await expect(page.getByRole('button', { name: `Pro look ${i}` })).toBeVisible();
  276 |     }
  277 |   });
  278 | 
  279 |   test('Pro can set a text brand mark; Free is pointed at Pro', async ({ page }) => {
  280 |     await ready(page);
  281 |     await page.keyboard.press('Control+,');
  282 |     await expect(page.getByRole('button', { name: 'Get Pro' })).toBeVisible();
  283 | 
  284 |     await page.goto('/?mock=1&theme=light&delay=0&lic=pro');
  285 |     await expect(page.locator('.pv-inspector')).toBeVisible();
  286 |     await page.keyboard.press('Control+,');
  287 |     await page.getByRole('radio', { name: 'Text' }).click();
  288 |     await page.getByLabel('Text', { exact: true }).fill('maya.dev');
  289 |     await page.keyboard.press('Enter');
  290 |     await expect.poll(() => page.evaluate(() => (window as unknown as { __polishotApp: { editor: { brandMark: { text?: string } | null } } }).__polishotApp.editor.brandMark?.text)).toBe('maya.dev');
  291 |   });
  292 | 
  293 |   test('the pricing link opens through the opener plugin', async ({ page }) => {
  294 |     await ready(page);
  295 |     await page.getByRole('button', { name: /License: Free/ }).click();
  296 |     await page.getByRole('button', { name: 'Buy Pro' }).first().click();
  297 |     await expect.poll(async () => (await last(page)).openedUrl).toMatch(/^https:\/\/.+\/pricing$/);
  298 |   });
  299 | });
  300 | 
  301 | test.describe('keyboard and accessibility', () => {
  302 |   test('every icon-only button has an accessible name', async ({ page }) => {
  303 |     await ready(page);
  304 |     const unnamed = await page.evaluate(() =>
  305 |       [...document.querySelectorAll<HTMLButtonElement>('button')]
  306 |         .filter((b) => !(b.getAttribute('aria-label') || b.textContent?.trim() || b.getAttribute('title')))
  307 |         .map((b) => b.outerHTML.slice(0, 120)),
  308 |     );
  309 |     expect(unnamed).toEqual([]);
  310 |   });
  311 | 
  312 |   test('Tab reaches the title bar controls in visual order with a visible focus ring', async ({ page }) => {
  313 |     await ready(page);
  314 |     await page.keyboard.press('Tab');
  315 |     const names: string[] = [];
  316 |     for (let i = 0; i < 6; i++) {
  317 |       names.push((await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? '')) ?? '');
  318 |       await page.keyboard.press('Tab');
  319 |     }
  320 |     expect(names[0]).toMatch(/Open command palette/);
  321 |     expect(names.slice(1, 4)).toEqual([expect.stringMatching(/Copy/), expect.stringMatching(/Save/), expect.stringMatching(/Pin/)]);
  322 |     await page.keyboard.press('Shift+Tab');
  323 |     const ring = await page.evaluate(() => getComputedStyle(document.activeElement as Element).outlineStyle);
  324 |     expect(ring).toBe('solid');
  325 |   });
  326 | 
  327 |   test('reduced motion removes transitions and animations', async ({ browser }) => {
  328 |     const context = await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1040, height: 680 } });
  329 |     const page = await context.newPage();
  330 |     await ready(page);
  331 |     const dur = await page.evaluate(() => getComputedStyle(document.querySelector('.pv-tab') as Element).transitionDuration);
  332 |     expect(parseFloat(dur)).toBeLessThanOrEqual(0.001);
  333 |     await context.close();
  334 |   });
  335 | });
  336 | 
```