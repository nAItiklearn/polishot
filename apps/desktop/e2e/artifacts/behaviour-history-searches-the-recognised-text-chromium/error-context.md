# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: behaviour.spec.ts >> history >> searches the recognised text
- Location: e2e\behaviour.spec.ts:169:3

# Error details

```
Error: expect(locator).toHaveCount(expected) failed

Locator:  locator('.pv-hcard')
Expected: 1
Received: 2
Timeout:  10000ms

Call log:
  - Expect "toHaveCount" locator('.pv-hcard') with timeout 10000ms
  - waiting for locator('.pv-hcard')
    4 × locator resolved to 10 elements
      - unexpected value "10"
    19 × locator resolved to 2 elements
       - unexpected value "2"

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
      - button "History" [pressed] [ref=e15] [cursor=pointer]:
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
      - 'button "License: Free. Open license." [ref=e23] [cursor=pointer]': Free
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
        - heading "History" [level=1] [ref=e39]
        - generic [ref=e40]:
          - searchbox "Search the text in your captures" [active] [ref=e45]: gateway
          - button "Clear all" [ref=e46] [cursor=pointer]
      - list "Captures" [ref=e48]:
        - listitem [ref=e49]:
          - button "Open the capture from Today, 10:46 PM, 1600 × 900" [ref=e50] [cursor=pointer]:
            - generic [ref=e52]:
              - generic [ref=e53]: Today, 10:46 PM
              - generic [ref=e54]: 1600 × 900
            - generic [ref=e55]: Deploy succeeded production api-gateway 42 seconds ago
          - button "Delete the capture from Today, 10:46 PM" [ref=e56] [cursor=pointer]:
            - generic [aria-hidden]: Delete the capture from Today, 10:46 PM
        - listitem [ref=e60]:
          - button "Open the capture from Yesterday, 9:41 PM, 1280 × 720" [ref=e61] [cursor=pointer]:
            - generic [ref=e63]:
              - generic [ref=e64]: Yesterday, 9:41 PM
              - generic [ref=e65]: 1280 × 720
            - generic [ref=e66]: Error 502 bad gateway upstream timed out after 30s
          - button "Delete the capture from Yesterday, 9:41 PM" [ref=e67] [cursor=pointer]:
            - generic [aria-hidden]: Delete the capture from Yesterday, 9:41 PM
  - region "Notifications"
```

# Test source

```ts
  73  |     const first = await page.evaluate(() => (window as unknown as { __polishotApp: { editor: { doc: { image: { id: string } } } } }).__polishotApp.editor.doc.image.id);
  74  |     await page.keyboard.press('Control+o');
  75  |     await expect.poll(() => page.evaluate(() => (window as unknown as { __polishotApp: { editor: { doc: { image: { id: string } } } } }).__polishotApp.editor.doc.image.id)).not.toBe(first);
  76  |     const second = await page.evaluate(() => (window as unknown as { __polishotApp: { editor: { doc: { image: { id: string } } } } }).__polishotApp.editor.doc.image.id);
  77  |     await page.keyboard.press('Control+v');
  78  |     await expect.poll(() => page.evaluate(() => (window as unknown as { __polishotApp: { editor: { doc: { image: { id: string } } } } }).__polishotApp.editor.doc.image.id)).not.toBe(second);
  79  |   });
  80  | 
  81  |   test('Ctrl+V with an empty clipboard explains what to do', async ({ page }) => {
  82  |     await ready(page, 'clip=empty');
  83  |     await page.keyboard.press('Control+v');
  84  |     await expect(toast(page, /no image on the clipboard/i)).toBeVisible();
  85  |   });
  86  | 
  87  |   test('Esc hides the window, but first leaves tools and other screens', async ({ page }) => {
  88  |     await ready(page);
  89  |     await page.keyboard.press('a'); // arrow tool
  90  |     await page.keyboard.press('Escape'); // the editor returns to Select first
  91  |     expect((await last(page)).windowCalls).not.toContain('hide');
  92  |     await page.keyboard.press('Control+h');
  93  |     await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  94  |     await page.keyboard.press('Escape'); // back to the editor
  95  |     await expect(page.locator('.pv-inspector')).toBeVisible();
  96  |     expect((await last(page)).windowCalls).not.toContain('hide');
  97  |     await page.keyboard.press('Escape'); // nothing left to leave: hide
  98  |     await expect.poll(async () => (await last(page)).windowCalls).toContain('hide');
  99  |   });
  100 | 
  101 |   test('Ctrl+K lists every action with its shortcut and runs one', async ({ page }) => {
  102 |     await ready(page);
  103 |     await page.keyboard.press('Control+k');
  104 |     const dialog = page.getByRole('dialog', { name: 'Command palette' });
  105 |     await expect(dialog).toBeVisible();
  106 |     const options = dialog.getByRole('option');
  107 |     expect(await options.count()).toBeGreaterThan(30); // actions + one per tool
  108 |     // Every row has its shortcut as key caps.
  109 |     const without = await dialog.locator('.pv-palette-item').evaluateAll((els) => els.filter((e) => !e.querySelector('.pv-kbd')).map((e) => e.textContent));
  110 |     expect(without).toEqual([]);
  111 |     await page.keyboard.type('history');
  112 |     await page.keyboard.press('Enter');
  113 |     await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  114 |     await expect(dialog).toHaveCount(0);
  115 |   });
  116 | 
  117 |   test('Ctrl+1..4 switch the inspector tabs; the Redact tab carries the count', async ({ page }) => {
  118 |     await ready(page);
  119 |     await expect(page.getByRole('tab', { name: /^Redact/ })).toContainText('4');
  120 |     await page.keyboard.press('Control+3');
  121 |     await expect(page.getByRole('tab', { name: 'Text', selected: true })).toBeVisible();
  122 |     await page.keyboard.press('Control+4');
  123 |     await expect(page.getByRole('tab', { name: 'Export', selected: true })).toBeVisible();
  124 |     await page.keyboard.press('Control+1');
  125 |     await expect(page.getByRole('tab', { name: 'Style', selected: true })).toBeVisible();
  126 |   });
  127 | 
  128 |   test('a dropped image opens', async ({ page }) => {
  129 |     await ready(page);
  130 |     const first = await page.evaluate(() => (window as unknown as { __polishotApp: { editor: { doc: { image: { id: string } } } } }).__polishotApp.editor.doc.image.id);
  131 |     await page.evaluate(() => (window as unknown as { __polishotMock: { emit: (e: string, p: unknown) => void } }).__polishotMock.emit('tauri://drag-drop', { paths: ['C:\\Users\\you\\Pictures\\a.png'] }));
  132 |     await expect.poll(() => page.evaluate(() => (window as unknown as { __polishotApp: { editor: { doc: { image: { id: string } } } } }).__polishotApp.editor.doc.image.id)).not.toBe(first);
  133 |     await page.evaluate(() => (window as unknown as { __polishotMock: { emit: (e: string, p: unknown) => void } }).__polishotMock.emit('tauri://drag-drop', { paths: ['C:\\notes.txt'] }));
  134 |     await expect(toast(page, /not an image/)).toBeVisible();
  135 |   });
  136 | });
  137 | 
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
  172 |     await page.getByRole('searchbox').fill('gateway');
> 173 |     await expect(page.locator('.pv-hcard')).toHaveCount(1);
      |                                             ^ Error: expect(locator).toHaveCount(expected) failed
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
  265 |       await expect(page.getByRole('button', { name: `Look ${i}` })).toBeVisible();
  266 |     }
  267 |     await expect(page.getByPlaceholder('Name this look')).toHaveCount(0); // no field once the limit is reached
  268 |     await expect(page.getByText('You have saved all 3 looks that Free includes.')).toBeVisible();
  269 | 
  270 |     await page.goto('/?mock=1&theme=light&delay=0&lic=pro');
  271 |     await expect(page.locator('.pv-inspector')).toBeVisible();
  272 |     for (let i = 1; i <= 4; i++) {
  273 |       await page.getByPlaceholder('Name this look').fill(`Pro look ${i}`);
```