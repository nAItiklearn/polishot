# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: flow.e2e.ts >> event to first paint, steady state
- Location: e2e\flow.e2e.ts:198:1

# Error details

```
Error: expect(received).toBeGreaterThan(expected)

Expected: > 3
Received:   3

Call Log:
- Test timeout of 60000ms exceeded
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
                - generic "0 of 3 saved looks used" [ref=e258]: 0 of 3
              - generic [ref=e259]:
                - generic [ref=e260]:
                  - generic [ref=e261]: Name for this look
                  - textbox "Name for this look" [ref=e262]:
                    - /placeholder: Name this look
                  - button "Save" [disabled] [ref=e263]
                - paragraph [ref=e264]: Free keeps 3 presets — Pro removes the limit
            - region "Brand mark" [ref=e265]:
              - generic [ref=e266]:
                - heading "Brand mark" [level=3] [ref=e267]
                - generic [ref=e268]: Pro
              - note "Brand mark is a Pro feature. Your logo or name instead of the watermark." [ref=e270]:
                - generic [ref=e274]: Your logo or name instead of the watermark
  - region "Notifications"
```

# Test source

```ts
  108 |   const snapped = dy < 0.5 || dx < 0.5 || Math.abs(dx - dy) < 0.5;
  109 |   expect(snapped, `arrow ${dx.toFixed(1)} x ${dy.toFixed(1)} is a multiple of 45 degrees`).toBe(true);
  110 |   await shot(page, '06-arrow-drawn');
  111 | 
  112 |   // 4. Two numbered steps; the tool stays active between clicks.
  113 |   await page.keyboard.press('n');
  114 |   await page.mouse.click(box.x + box.w * 0.3, box.y + box.h * 0.35);
  115 |   await page.mouse.click(box.x + box.w * 0.45, box.y + box.h * 0.35);
  116 |   const twoSteps = await probe(page);
  117 |   expect(twoSteps.annotations.filter((a) => a.type === 'step').map((a) => a.n)).toEqual([1, 2]);
  118 |   await shot(page, '07-two-steps');
  119 | 
  120 |   // 5. Delete the first: the second becomes 1.
  121 |   await page.keyboard.press('v');
  122 |   await page.mouse.click(box.x + box.w * 0.3, box.y + box.h * 0.35);
  123 |   await page.keyboard.press('Delete');
  124 |   const afterDelete = await probe(page);
  125 |   expect(afterDelete.annotations.filter((a) => a.type === 'step').map((a) => a.n)).toEqual([1]);
  126 |   await shot(page, '08-first-step-deleted');
  127 | 
  128 |   // 6. Redactions in one click.
  129 |   await page.getByRole('button', { name: 'Hide' }).click();
  130 |   const redacted = await probe(page);
  131 |   expect(redacted.annotations.filter((a) => a.type === 'blur').length).toBeGreaterThanOrEqual(4);
  132 |   await expect(page.locator('.pv-found')).toHaveCount(0);
  133 |   await shot(page, '09-redacted');
  134 | 
  135 |   // 7. Undo three times, redo once.
  136 |   await page.mouse.move(600, 620);
  137 |   const counts: number[] = [redacted.annotations.length];
  138 |   for (let i = 0; i < 3; i++) {
  139 |     await page.keyboard.press('Control+z');
  140 |     counts.push((await probe(page)).annotations.length);
  141 |   }
  142 |   expect(counts[1]).toBeLessThan(counts[0]!); // the first undo took the redactions back
  143 |   await shot(page, '10-undone-three-times');
  144 |   await page.keyboard.press('Control+Shift+z');
  145 |   const redone = await probe(page);
  146 |   expect(redone.annotations.length).toBeGreaterThanOrEqual(counts[3]!);
  147 |   await shot(page, '11-redone');
  148 | 
  149 |   // 8. Copy. Right after editing nothing is prepared yet (cold); after a pause it is instant (warm).
  150 |   const t0 = Date.now();
  151 |   await page.keyboard.press('Control+c');
  152 |   await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
  153 |   const coldToastMs = Date.now() - t0;
  154 |   const cold = await lastCopyMs(page);
  155 |   await shot(page, '12-copied');
  156 | 
  157 |   await page.keyboard.press('Control+z'); // an edit, so the prepared image is stale again
  158 |   await page.waitForTimeout(3200); // the quiet moment in which Copy is prepared
  159 |   const t1 = Date.now();
  160 |   await page.keyboard.press('Control+c');
  161 |   await expect(page.getByRole('status').filter({ hasText: 'Copied' }).last()).toBeVisible();
  162 |   const warmToastMs = Date.now() - t1;
  163 |   const warm = await lastCopyMs(page);
  164 | 
  165 |   const result = await page.evaluate(() => ({
  166 |     bytes: (window as unknown as { __polishotMock: { last: { copiedImageBytes?: number } } }).__polishotMock.last.copiedImageBytes ?? 0,
  167 |     paint: (window as unknown as { __polishotTiming?: Array<{ totalMs: number }> }).__polishotTiming?.[0]?.totalMs ?? -1,
  168 |   }));
  169 |   expect(result.bytes).toBeGreaterThan(1000);
  170 |   console.log(`hover preview active while hovering a swatch: ${hovering.previewing}`);
  171 |   console.log(`event-to-first-paint ${result.paint.toFixed(0)} ms`);
  172 |   console.log(`copy cold: ${cold.toFixed(0)} ms (keypress to toast ${coldToastMs} ms); copy warm: ${warm.toFixed(0)} ms (keypress to toast ${warmToastMs} ms)`);
  173 |   console.log(log.join(String.fromCharCode(10)));
  174 |   expect(warm).toBeLessThan(300);
  175 | });
  176 | 
  177 | async function lastCopyMs(page: Page): Promise<number> {
  178 |   return page.evaluate(() => (window as unknown as { __polishotLastExportMs?: { copy?: number } }).__polishotLastExportMs?.copy ?? -1);
  179 | }
  180 | 
  181 | test('copy on a 4K capture: cold and warm', async ({ page }) => {
  182 |   await page.goto('/?mock=1&theme=light&delay=0&size=4k');
  183 |   await expect(page.locator('.pv-inspector')).toBeVisible();
  184 |   const paint = await page.evaluate(() => (window as unknown as { __polishotTiming?: Array<{ totalMs: number }> }).__polishotTiming?.[0]?.totalMs ?? -1);
  185 |   await page.keyboard.press('Control+c'); // straight away: nothing prepared
  186 |   await expect(page.getByRole('status').filter({ hasText: 'Copied' })).toBeVisible();
  187 |   const cold = await lastCopyMs(page);
  188 |   await page.keyboard.press('Control+z'); // no-op edit target: the document is unchanged, so the first render is reused
  189 |   await page.waitForTimeout(500);
  190 |   await page.keyboard.press('Control+c');
  191 |   await expect(page.getByRole('status').filter({ hasText: 'Copied' }).last()).toBeVisible();
  192 |   const second = await lastCopyMs(page);
  193 |   console.log(`4K: event-to-first-paint ${paint.toFixed(0)} ms; copy cold ${cold.toFixed(0)} ms; copy again (prepared) ${second.toFixed(0)} ms`);
  194 |   expect(cold).toBeGreaterThan(0);
  195 |   expect(second).toBeLessThan(300);
  196 | });
  197 | 
  198 | test('event to first paint, steady state', async ({ page }) => {
  199 |   await page.goto('/?mock=1&theme=light&delay=0');
  200 |   await expect(page.locator('.pv-inspector')).toBeVisible();
  201 |   await page.waitForTimeout(1500); // let the dev server finish loading modules: the first capture pays for that
  202 |   const runs: number[] = [];
  203 |   for (let i = 0; i < 5; i++) {
  204 |     const before = await page.evaluate(() => (window as unknown as { __polishotTiming?: unknown[] }).__polishotTiming?.length ?? 0);
  205 |     await page.evaluate(() => (window as unknown as { __polishotMock: { newCapture: () => void } }).__polishotMock.newCapture());
  206 |     await expect
  207 |       .poll(() => page.evaluate(() => (window as unknown as { __polishotTiming?: unknown[] }).__polishotTiming?.length ?? 0), { timeout: 15_000 })
> 208 |       .toBeGreaterThan(before);
      |        ^ Error: expect(received).toBeGreaterThan(expected)
  209 |     runs.push(await page.evaluate(() => (window as unknown as { __polishotTiming: Array<{ totalMs: number }> }).__polishotTiming.at(-1)!.totalMs));
  210 |     await page.waitForTimeout(400);
  211 |   }
  212 |   const sorted = [...runs].sort((a, b) => a - b);
  213 |   console.log(`capture:ready to first paint (dev build, headless, 1280x800): ${runs.map((r) => r.toFixed(0)).join(', ')} ms; median ${sorted[2]!.toFixed(0)} ms`);
  214 |   expect(sorted[2]!).toBeLessThan(500);
  215 | });
  216 | 
```