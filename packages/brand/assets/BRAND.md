# Polishot mark

## Idea: the Print P
A P whose bowl is a print: your screenshot, tilted -6 degrees and pinned onto the stem like a
darkroom print fresh off the line. The counter is the print's window, knocked out so whatever
is behind shows through. The P stands for the name and the print stands for the product
(*your screenshot, polished*). The slight tilt gives it the personality: confident and a little
playful, but not cartoonish.

The mark has two shapes and solid fills: an ink stem and a persimmon print. There are no gradients
in the mark itself. Depth lives only in the app-icon tile.

The other concepts explored are in `concepts/sheet.png`: Lifted print, Wipe, Crop grin and Loupe P.
Print P was chosen because it was the only one that is a letter, a screenshot and a gesture at once.
It stays a clear P at 16 px, and it is unlike any screenshot-tool mark: no aperture, no crop
brackets around a lens, no ribbon S, no pinwheel.

## Construction
- The grid is 64 x 64 (1 unit = 0.25 px at 16 px). The geometry lives in `../scripts/lib/mark.mjs`.
- Stem: 10u wide. Print: 40 x 31u, r 7.5, tilted -6 degrees. Window: 21 x 15u, r 2.5.
- The frame is 11u on the left and 8u elsewhere. The heavier left side is an optical correction:
  the stem tucks under it and the tilt lifts the right side.
- The stem never touches the window, so the single-colour version stays a clean P silhouette.
- The mark is placed slightly low of the geometric centre because the bowl is top-heavy.

## Clear space and minimum size
- Clear space on every side equals the window height, 15u (about 0.3 x the mark height).
  The lockup files include it.
- Minimum size: the mark at 16 px, the wordmark lockup at 20 px tall. Below 32 px, use
  `app-icon-small.svg`, which has a larger mark and no shadow.

## Colour
| Use | Ink | Accent |
|---|---|---|
| Light surfaces | `#161615` | `#C8471D` |
| Dark / ember surfaces | `#EDECE8` | `#EE7444` |
| App tile | tile `#141311` with a warm top highlight and an ember glow at the bottom left; stem `#EDECE8`, print `#EE7444` | |
| Mono (tray, themed icons) | one colour: `currentColor` / `#161615` / `#EDECE8`, or `#C8471D` for a tray that must work on both taskbar themes | |

## Do
- Keep the tilt and the knockout window.
- Use the dark-theme colours on the website's ember backgrounds.
- Use the mono mark wherever only one colour is possible.

## Don't
- Don't straighten, re-tilt, outline, or add gradients or sparkles to the mark.
- Don't fill the window with a colour. It must stay a knockout.
- Don't recolour the print in anything other than persimmon. Don't place the two-colour mark on
  mid-tone or busy photos (use mono instead).
- Don't reset the wordmark in a live font. Use the outlined files.

## Files
- `logo-mark.svg`: the primary two-colour mark (light-theme colours).
- `logo-mark-mono.svg`: a single colour (`currentColor`).
- `logo-wordmark.svg`: the mark plus "Polishot" in Instrument Serif, outlined and kerned by hand,
  with no clear space.
- `logo-lockup-light.svg` and `logo-lockup-dark.svg`: the wordmark with clear space, for light and
  dark backgrounds.
- `app-icon.svg` (1024 master), `app-icon-small.svg` (for 16 to 32 px) and `app-icon-square.svg`
  (full bleed for iOS and the stores).
- `android-adaptive-foreground.svg`, `-background.svg` and `-monochrome.svg`: a 108 dp canvas.
  The mark is about 40 dp tall, with its diagonal at 53 dp, inside the 66 dp safe zone.
- `png/` (`icon-*`, `mark-*`, `mark-mono-*`, `icon-square-*`) and `icon.ico` (16/24/32/48/64/256,
  PNG-in-ICO).
- `final-preview.png` and `concepts/` (concept SVGs plus `sheet.png`).

## Scripts (run from the repo root)
- `node packages/brand/scripts/build-masters.mjs` regenerates every master SVG from the
  geometry and the font. It overwrites hand edits to those files.
- `node packages/brand/scripts/export-icons.mjs` writes `png/` and `icon.ico`. Flags:
  `--tauri`, `--web`, `--android` and `--all` write into the apps. `--stage <dir>` writes the
  app files into a scratch directory for review, and `--dry-run` lists them.
- `node packages/brand/scripts/final-preview.mjs` and `concept-sheet.mjs` render the review sheets.

Instrument Serif is licensed under OFL 1.1. The outlines come from
`apps/android/app/src/main/res/font/instrument_serif.ttf`.
