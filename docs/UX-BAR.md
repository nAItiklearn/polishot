# Polishot — Interaction Quality Bar

Owner's requirement: *clicking and editing must feel as clean and effortless as the best Mac
screenshot apps.* Take inspiration from the category; never copy any app's code, assets, layout
or text. Every editor surface (desktop preview, web editor, Android) must meet all of this.

## Zero-decision first impression
- The capture opens already beautiful: auto-balance, auto background, rounded corners, soft shadow.
  The user should be able to press Ctrl+C immediately and get a great result. Never show an
  unstyled raw screenshot first and "then" style it — no visible flash or re-layout.
- Detected sensitive items show as a small count badge ("3 found"), not a modal. One click hides all.

## Direct manipulation, no friction
- **One click to act.** Picking a background swatch, preset, frame or padding applies instantly with
  a live preview; no "Apply" buttons, no confirm dialogs except for destructive history actions.
- **Hover previews.** Hovering a background swatch or preset previews it on canvas (≤ 16 ms),
  leaving restores; click commits. Respect reduced motion (no animated transitions, still preview).
- **Sliders feel physical.** Padding, radius, shadow, blur strength update every frame while dragging
  (60 fps on a 4K capture); the whole drag is one undo step; value readout visible; arrow keys nudge
  by 1, Shift+arrow by 10; double-click resets to default.
- **Drawing is immediate.** Tool cursor matches the tool; the shape appears on pointer-down and
  tracks the pointer with no lag; Shift constrains (45° lines/arrows, squares/circles); after drawing,
  the tool stays active for another shape (Esc or V returns to select). Text tool: click → type →
  click away commits; empty text is discarded.
- **Selection is obvious and quiet.** Thin accent outline, small round handles, never a heavy box.
  Click to select, drag to move, handles to resize, Delete to remove, arrow keys nudge 1 px
  (Shift = 10 px), Ctrl+D duplicate. Clicking empty canvas deselects.
- **Numbered steps** auto-increment and renumber when one is deleted.
- **Undo is fearless.** Every action is undoable, including applying redactions and background changes.
  Ctrl+Z never "skips" or merges unrelated actions.

## Speed you can feel
- Hotkey → styled preview visible < 500 ms. Every inspector change → canvas updated next frame.
- Copy to clipboard < 300 ms for a 4K capture with a toast "Copied". Export never freezes the UI.
- No spinners for local work under 300 ms. OCR runs in the background; the UI is usable meanwhile.

## Calm chrome
- Canvas is the hero: ≥ 70% of the window. Inspector 280 px, one column, grouped with hairlines and
  small labels, most-used controls first (Background, Padding, Ratio/Preset, Frame, Shadow, Radius).
- Toolbar: one floating pill, icons only, tooltip with name + shortcut after 400 ms.
- No more than one accent-coloured element visible at rest (the primary action, e.g. Copy).
- Empty/edge states are one plain sentence. Errors say what happened and what to do next.

## Keyboard-first
- Every action has a shortcut listed in the command palette (Ctrl+K). Tab order follows the visual order.
- Focus rings visible only for keyboard users (`:focus-visible`).

## Acceptance check (do this before reporting done)
Record or screenshot this flow and review it critically: open a capture → change background by
hovering then clicking → drag padding slider → draw an arrow with Shift → add two numbered steps →
delete the first (second renumbers) → apply detected redactions → undo three times → redo → copy.
If any step needs an extra click, shows a flash, lags, or looks cluttered, fix it.
