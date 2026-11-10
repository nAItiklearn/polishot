# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: behaviour.spec.ts >> licence and Pro >> Free allows 3 saved looks, then asks for Pro; Pro has no limit
- Location: e2e\behaviour.spec.ts:260:3

# Error details

```
Error: expect(locator).toBeVisible() failed

Locator: getByRole('button', { name: 'Look 1' })
Expected: visible
Error: strict mode violation: getByRole('button', { name: 'Look 1' }) resolved to 2 elements:
    1) <button type="button" class="pe-look-apply">Look 1</button> aka getByRole('button', { name: 'Look 1', exact: true })
    2) <button type="button" class="pe-look-del" aria-label="Delete look Look 1">…</button> aka getByRole('button', { name: 'Delete look Look' })

Call log:
  - Expect "toBeVisible" getByRole('button', { name: 'Look 1' }) with timeout 10000ms
  - waiting for getByRole('button', { name: 'Look 1' })

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
      - button "Copy" [ref=e15] [cursor=pointer]
      - button "Save" [ref=e20] [cursor=pointer]
      - button "Pin to screen" [ref=e26] [cursor=pointer]:
        - generic [aria-hidden]:
          - text: Pin to screen
          - generic:
            - generic: Ctrl
            - generic: P
      - button "History" [ref=e30] [cursor=pointer]:
        - generic [aria-hidden]:
          - text: History
          - generic:
            - generic: Ctrl
            - generic: H
      - button "Settings" [ref=e34] [cursor=pointer]:
        - generic [aria-hidden]:
          - text: Settings
          - generic:
            - generic: Ctrl
            - generic: ","
      - 'button "License: Free. Open license." [ref=e38] [cursor=pointer]': Free
    - generic [ref=e39]:
      - button "Minimize" [ref=e40]
      - button "Maximize" [ref=e42]
      - button "Close to tray" [ref=e45]
  - main [ref=e48]:
    - generic [ref=e49]:
      - region "Canvas" [ref=e50]:
        - generic [ref=e51]:
          - group "Screenshot canvas" [ref=e53]
          - group "Recognised text":
            - generic [ref=e58]: Northwind
            - generic [ref=e59]: Overview
            - generic [ref=e60]: Projects
            - generic [ref=e61]: Billing
            - generic [ref=e62]: Team
            - generic [ref=e63]: Settings
            - generic [ref=e64]: Maya
            - generic [ref=e65]: Chen
            - generic [ref=e66]: Workspace
            - generic [ref=e67]: /
            - generic [ref=e68]: Billing
            - generic [ref=e69]: Billing
            - generic [ref=e70]: Manage
            - generic [ref=e71]: your
            - generic [ref=e72]: plan,
            - generic [ref=e73]: payment
            - generic [ref=e74]: method
            - generic [ref=e75]: and
            - generic [ref=e76]: invoices.
            - generic [ref=e77]: Account
            - generic [ref=e78]: Billing
            - generic [ref=e79]: email
            - generic [ref=e80]: maya.chen@northwind-labs.com
            - generic [ref=e81]: Payment
            - generic [ref=e82]: method
            - generic [ref=e83]: Visa
            - generic [ref=e84]: "4111"
            - generic [ref=e85]: "1111"
            - generic [ref=e86]: "1111"
            - generic [ref=e87]: "1111"
            - generic [ref=e88]: exp
            - generic [ref=e89]: 08/29
            - generic [ref=e90]: Last
            - generic [ref=e91]: sign-in
            - generic [ref=e92]: 203.0.113.42
            - generic [ref=e93]: from
            - generic [ref=e94]: Berlin,
            - generic [ref=e95]: DE
            - generic [ref=e96]: Deploy
            - generic [ref=e97]: token
            - generic [ref=e98]: ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5
            - generic [ref=e99]: Invoices
            - generic [ref=e100]: Update
            - generic [ref=e101]: payment
            - generic [ref=e102]: method
            - generic [ref=e103]: Date
            - generic [ref=e104]: Description
            - generic [ref=e105]: Amount
            - generic [ref=e106]: Status
            - generic [ref=e107]: Oct
            - generic [ref=e108]: 1,
            - generic [ref=e109]: "2026"
            - generic [ref=e110]: Team
            - generic [ref=e111]: plan,
            - generic [ref=e112]: "6"
            - generic [ref=e113]: seats
            - generic [ref=e114]: $114.00
            - generic [ref=e115]: Paid
            - generic [ref=e116]: Sep
            - generic [ref=e117]: 1,
            - generic [ref=e118]: "2026"
            - generic [ref=e119]: Team
            - generic [ref=e120]: plan,
            - generic [ref=e121]: "6"
            - generic [ref=e122]: seats
            - generic [ref=e123]: $114.00
            - generic [ref=e124]: Paid
            - generic [ref=e125]: Aug
            - generic [ref=e126]: 1,
            - generic [ref=e127]: "2026"
            - generic [ref=e128]: Team
            - generic [ref=e129]: plan,
            - generic [ref=e130]: "5"
            - generic [ref=e131]: seats
            - generic [ref=e132]: $95.00
            - generic [ref=e133]: Paid
          - group "Sensitive data" [ref=e134]:
            - status [ref=e135]: 4 found
            - button "Hide" [ref=e136] [cursor=pointer]
          - toolbar "Annotation tools" [ref=e142]:
            - group [ref=e143]:
              - button "Select" [pressed] [ref=e144] [cursor=pointer]:
                - generic [aria-hidden]:
                  - text: Select
                  - generic: V
            - group [ref=e147]:
              - button "Arrow" [ref=e148] [cursor=pointer]:
                - generic [aria-hidden]:
                  - text: Arrow
                  - generic: A
              - button "Line" [ref=e152] [cursor=pointer]:
                - generic [aria-hidden]:
                  - text: Line
                  - generic: L
              - button "Rectangle" [ref=e154] [cursor=pointer]:
                - generic [aria-hidden]:
                  - text: Rectangle
                  - generic: R
              - button "Ellipse" [ref=e157] [cursor=pointer]:
                - generic [aria-hidden]:
                  - text: Ellipse
                  - generic: E
            - group [ref=e160]:
              - button "Text" [ref=e161] [cursor=pointer]:
                - generic [aria-hidden]:
                  - text: Text
                  - generic: T
              - button "Step" [ref=e164] [cursor=pointer]:
                - generic [aria-hidden]:
                  - text: Step
                  - generic: "N"
            - group [ref=e168]:
              - button "Blur" [ref=e169] [cursor=pointer]:
                - generic [aria-hidden]:
                  - text: Blur
                  - generic: B
              - button "Redact brush" [ref=e172] [cursor=pointer]:
                - generic [aria-hidden]:
                  - text: Redact brush
                  - generic: P
            - separator [ref=e177]
            - group [ref=e178]:
              - button "Undo" [disabled] [ref=e179]
              - button "Redo" [disabled] [ref=e183]
              - button "Delete selection" [disabled] [ref=e187]
      - complementary "Inspector" [ref=e191]:
        - tablist "Inspector sections" [ref=e193]:
          - tab "Style" [selected] [ref=e194] [cursor=pointer]
          - tab "Redact 4 found" [ref=e195] [cursor=pointer]:
            - text: Redact
            - generic "4 found" [ref=e196]: "4"
          - tab "Text" [ref=e197] [cursor=pointer]
          - tab "Export" [ref=e198] [cursor=pointer]
        - tabpanel "Style" [ref=e199]:
          - complementary "Inspector" [ref=e200]:
            - region "Background" [ref=e201]:
              - heading "Background" [level=3] [ref=e203]
              - group "Background" [ref=e205]:
                - button "Auto background, derived from the screenshot edges" [pressed] [ref=e206] [cursor=pointer]: Auto
                - button "Warm stone" [ref=e207] [cursor=pointer]
                - button "Sand" [ref=e208] [cursor=pointer]
                - button "Sage" [ref=e209] [cursor=pointer]
                - button "Fog" [ref=e210] [cursor=pointer]
                - button "Muted clay" [ref=e211] [cursor=pointer]
                - button "Graphite" [ref=e212] [cursor=pointer]
                - button "Ink" [ref=e213] [cursor=pointer]
                - button "Paper" [ref=e214] [cursor=pointer]
                - button "Custom background" [ref=e215] [cursor=pointer]: Custom
            - region "Layout" [ref=e216]:
              - heading "Layout" [level=3] [ref=e218]
              - generic [ref=e219]:
                - generic [ref=e220]:
                  - generic [ref=e221]:
                    - generic [ref=e222]: Padding
                    - status [ref=e223]: 9%
                  - slider "Padding" [ref=e224] [cursor=pointer]: "0.087"
                - generic [ref=e225]:
                  - generic [ref=e226]:
                    - generic [ref=e227]: Corners
                    - status [ref=e228]: 12 px
                  - slider "Corners" [ref=e229] [cursor=pointer]: "12"
                - generic [ref=e230]:
                  - generic [ref=e231]:
                    - generic [ref=e232]: Shadow
                    - status [ref=e233]: 50%
                  - slider "Shadow" [ref=e234] [cursor=pointer]: "0.5"
            - region "Frame" [ref=e235]:
              - heading "Frame" [level=3] [ref=e237]
              - group "Frame" [ref=e239]:
                - button "None" [pressed] [ref=e240] [cursor=pointer]
                - button "Browser" [ref=e241] [cursor=pointer]
                - button "Browser dark" [ref=e242] [cursor=pointer]
                - button "Window" [ref=e243] [cursor=pointer]
                - button "Phone" [ref=e244] [cursor=pointer]
                - button "Laptop" [ref=e245] [cursor=pointer]
            - region "Canvas" [ref=e246]:
              - heading "Canvas" [level=3] [ref=e248]
              - generic [ref=e250]:
                - generic [ref=e251]:
                  - generic [ref=e252]: Size
                  - status [ref=e253]: 1408 × 896
                - combobox "Size" [ref=e254] [cursor=pointer]:
                  - option "Auto" [selected]
                  - option "X post · 1600×900"
                  - option "LinkedIn · 1200×627"
                  - option "Instagram square · 1080×1080"
                  - option "Instagram story · 1080×1920"
                  - option "YouTube thumbnail · 1280×720"
                  - option "Custom"
            - region "Saved looks" [ref=e255]:
              - generic [ref=e256]:
                - heading "Saved looks" [level=3] [ref=e257]
                - generic "1 of 3 saved looks used" [ref=e258]: 1 of 3
              - generic [ref=e259]:
                - list [ref=e260]:
                  - listitem [ref=e261]:
                    - button "Look 1" [ref=e262] [cursor=pointer]
                    - button "Delete look Look 1" [ref=e263] [cursor=pointer]
                - generic [ref=e267]:
                  - generic [ref=e268]: Name for this look
                  - textbox "Name for this look" [ref=e269]:
                    - /placeholder: Name this look
                  - button "Save" [disabled] [ref=e270]
                - paragraph [ref=e271]: Free keeps 3 presets — Pro removes the limit
            - region "Brand mark" [ref=e272]:
              - generic [ref=e273]:
                - heading "Brand mark" [level=3] [ref=e274]
                - generic [ref=e275]: Pro
              - note "Brand mark is a Pro feature. Your logo or name instead of the watermark." [ref=e277]:
                - generic [ref=e281]: Your logo or name instead of the watermark
  - region "Notifications"
```

# Test source

```ts
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
  238 |     await expect(page.getByText('Updates until')).toBeVisible();
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
> 265 |       await expect(page.getByRole('button', { name: `Look ${i}` })).toBeVisible();
      |                                                                     ^ Error: expect(locator).toBeVisible() failed
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