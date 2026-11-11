# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: flow.e2e.ts >> copy on a 4K capture: cold and warm
- Location: e2e\flow.e2e.ts:181:1

# Error details

```
Test timeout of 60000ms exceeded.
```

```
Error: page.goto: net::ERR_ABORTED; maybe frame was detached?
Call log:
  - navigating to "http://127.0.0.1:1421/?mock=1&theme=light&delay=0&size=4k", waiting until "load"

```

# Test source

```ts
  82  |     seen.add((await probe(page)).padding);
  83  |   }
  84  |   await page.mouse.up();
  85  |   const afterDrag = await probe(page);
  86  |   expect(afterDrag.padding).not.toBe(clicked.padding);
  87  |   expect(seen.size).toBeGreaterThan(3); // it updated while dragging, not just on release
  88  |   await shot(page, '04-padding-dragged');
  89  | 
  90  |   // 3. Arrow with Shift: the angle snaps to a multiple of 45 degrees.
  91  |   await page.keyboard.press('a');
  92  |   const box = await contentBox(page);
  93  |   const ax = box.x + box.w * 0.55;
  94  |   const ay = box.y + box.h * 0.72;
  95  |   await page.mouse.move(ax, ay);
  96  |   await page.keyboard.down('Shift');
  97  |   await page.mouse.down();
  98  |   await page.mouse.move(ax + 120, ay + 53, { steps: 6 }); // roughly 24 degrees: should snap to 0 or 45
  99  |   await shot(page, '05-arrow-while-drawing');
  100 |   await page.mouse.up();
  101 |   await page.keyboard.up('Shift');
  102 |   const withArrow = await probe(page);
  103 |   const arrow = withArrow.annotations.find((a) => a.type === 'arrow');
  104 |   expect(arrow, 'an arrow was drawn').toBeTruthy();
  105 |   const [x1, y1, x2, y2] = arrow!.points!;
  106 |   const dx = Math.abs(x2! - x1!);
  107 |   const dy = Math.abs(y2! - y1!);
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
> 182 |   await page.goto('/?mock=1&theme=light&delay=0&size=4k');
      |              ^ Error: page.goto: net::ERR_ABORTED; maybe frame was detached?
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
  208 |       .toBeGreaterThan(before);
  209 |     runs.push(await page.evaluate(() => (window as unknown as { __polishotTiming: Array<{ totalMs: number }> }).__polishotTiming.at(-1)!.totalMs));
  210 |     await page.waitForTimeout(400);
  211 |   }
  212 |   const sorted = [...runs].sort((a, b) => a - b);
  213 |   console.log(`capture:ready to first paint (dev build, headless, 1280x800): ${runs.map((r) => r.toFixed(0)).join(', ')} ms; median ${sorted[2]!.toFixed(0)} ms`);
  214 |   expect(sorted[2]!).toBeLessThan(500);
  215 | });
  216 | 
```