import { APP_NAME, WATERMARK_TEXT } from '@polishot/brand';
import { FREE_LIMITS } from './site';

export type Platform = 'Windows' | 'Android' | 'Windows and Android';

export interface Feature {
  id: string;
  name: string;
  platform: Platform;
  /** Plain sentences. Keys and shortcuts go in `keys`, not in the prose. */
  body: string[];
  keys?: string[];
}

export interface FeatureGroup {
  id: string;
  title: string;
  intro: string;
  items: Feature[];
}

const BOTH: Platform = 'Windows and Android';

/**
 * Every feature, grouped by what you are trying to do. The copy follows PLAN.md and docs/CONTRACTS.md;
 * if a feature changes there, change it here.
 */
export const FEATURE_GROUPS: FeatureGroup[] = [
  {
    id: 'capture',
    title: 'Capture',
    intro: 'Get pixels onto the screen of the editor, from wherever they are.',
    items: [
      {
        id: 'shortcut',
        name: 'Global shortcut',
        platform: 'Windows',
        body: [
          'One system-wide shortcut starts a capture from any app. The screen freezes and you drag a region.',
          'You choose the keys. The settings screen tells you when another program already uses them.',
        ],
      },
      {
        id: 'window-capture',
        name: 'Window capture',
        platform: 'Windows',
        body: [
          'Press Space while capturing to switch from region to window mode. Hover a window to outline it, click to capture it.',
          'A window that is partly covered by another one still captures whole.',
        ],
        keys: ['Space'],
      },
      {
        id: 'scrolling',
        name: 'Scrolling capture',
        platform: 'Windows',
        body: [
          `Pick a window and ${APP_NAME} scrolls it, grabs frames and stitches them into one tall image. Fixed headers are handled.`,
          `It stops on Esc, at a height limit, or when the content stops changing. Browsers, File Explorer and editors work well. If an app ignores scrolling, ${APP_NAME} says so instead of guessing.`,
        ],
      },
      {
        id: 'gif',
        name: 'GIF capture',
        platform: 'Windows',
        body: ['Record a region at 15 frames per second for up to 15 seconds and save it as a GIF.'],
      },
      {
        id: 'bubble',
        name: 'Capture bubble',
        platform: 'Android',
        body: [
          'A small floating button captures the screen from any app. It needs the display-over-other-apps permission, and the app explains why before it asks.',
        ],
      },
      {
        id: 'share-sheet',
        name: 'Share sheet',
        platform: 'Android',
        body: [
          `Choose "Beautify with ${APP_NAME}" in the share sheet of any app to open an image straight in the editor.`,
        ],
      },
      {
        id: 'open',
        name: 'Open from file, clipboard or drag and drop',
        platform: 'Windows',
        body: [
          'Open a PNG, JPEG, WebP or BMP, paste an image from the clipboard, or drop one onto the window.',
        ],
      },
      {
        id: 'pin',
        name: 'Pin to screen',
        platform: 'Windows',
        body: [
          'Keep a capture floating above every other window while you work. Resize it, change its opacity, and press Esc to close it.',
        ],
      },
    ],
  },
  {
    id: 'polish',
    title: 'Polish',
    intro: 'The part that usually takes a design tool and five minutes.',
    items: [
      {
        id: 'balance',
        name: 'Auto-balance',
        platform: BOTH,
        body: [
          'Trims uniform borders around the content, then adds even padding in proportion to what is left.',
        ],
      },
      {
        id: 'background',
        name: 'Auto background',
        platform: BOTH,
        body: [
          'Samples the colours along the edge of your screenshot and builds a matching background, so the frame never clashes.',
          'Prefer to choose? Use a solid colour, a gradient, or a blurred image.',
        ],
      },
      {
        id: 'frames',
        name: 'Mockup frames',
        platform: BOTH,
        body: [
          'Wrap the shot in a browser window (light or dark), a plain window, a phone or a laptop. The frames are simple drawn shapes, not photographs.',
        ],
      },
      {
        id: 'annotate',
        name: 'Annotation tools',
        platform: BOTH,
        body: [
          'Arrow, line, rectangle, ellipse, text, numbered steps, blur, and a redaction brush. Every tool has a one-key shortcut, and undo and redo cover each change.',
        ],
        keys: ['V', 'A', 'R', 'E', 'L', 'T', 'B', 'N', 'P'],
      },
    ],
  },
  {
    id: 'protect',
    title: 'Protect',
    intro: 'Cover what should not leave the screen, before it does.',
    items: [
      {
        id: 'redact',
        name: 'Auto-redact',
        platform: BOTH,
        body: [
          'Finds email addresses, card numbers, IPv4 and IPv6 addresses, and API keys or tokens in the text of the screenshot.',
          'Each find appears as a chip. Turn off any you want to keep, then cover the rest with blur or solid bars in one click.',
        ],
      },
      {
        id: 'redact-checks',
        name: 'How it decides',
        platform: BOTH,
        body: [
          'Card numbers must pass the Luhn check and match a known issuer prefix. Addresses are parsed, not guessed from a pattern.',
          'Keys are matched by known prefixes such as sk-, ghp_, AKIA and xox, and by a high-entropy check for tokens it has not seen before.',
        ],
      },
      {
        id: 'redact-limits',
        name: 'Check the result',
        platform: BOTH,
        body: [
          'Automatic detection is a convenience, not a guarantee. It reads what text recognition reads, and recognition can miss or misread. Look at the image before you share it.',
        ],
      },
    ],
  },
  {
    id: 'text',
    title: 'Text',
    intro: 'The words in the picture are still words.',
    items: [
      {
        id: 'ocr',
        name: 'Copy text',
        platform: BOTH,
        body: [
          'Text recognition runs on your device. Drag across the words in a screenshot and copy them.',
          'Windows uses its built-in OCR, which needs the language pack for your language. Android uses an on-device model that ships with the app.',
        ],
        keys: ['Ctrl+C'],
      },
      {
        id: 'history',
        name: 'History',
        platform: BOTH,
        body: [
          'Every capture is kept on your device, still editable, and searchable by the text inside it. Delete one capture or clear everything.',
        ],
      },
    ],
  },
  {
    id: 'share',
    title: 'Share',
    intro: 'Out of the editor, at the right size.',
    items: [
      {
        id: 'presets',
        name: 'Social presets',
        platform: BOTH,
        body: [
          'X at 1600 by 900, LinkedIn at 1200 by 627, Instagram square at 1080 by 1080, Instagram story at 1080 by 1920, YouTube thumbnail at 1280 by 720, or a custom size.',
          `Save your own looks as presets: ${FREE_LIMITS.presets} on Free, unlimited on Pro.`,
        ],
      },
      {
        id: 'export',
        name: 'Export formats',
        platform: BOTH,
        body: [
          'PNG, JPEG or WebP, at 1x, 2x or 3x, with a quality slider for the lossy formats. Save to a folder, copy the image to the clipboard, or hand it to the system share sheet.',
        ],
      },
      {
        id: 'quick-send',
        name: 'Quick send',
        platform: BOTH,
        body: [
          'Send an image between your PC and your phone over the local network. Pair once by confirming a six-digit code on both screens.',
          'Transfers are encrypted with AES-256-GCM and go directly between the two devices. The receiving side accepts or declines each one. No account, no cloud. Windows may ask about its firewall the first time.',
        ],
      },
      {
        id: 'batch',
        name: 'Batch',
        platform: 'Windows',
        body: [
          `Pick a set of files and a preset. ${APP_NAME} beautifies them all and writes the results to a folder.`,
          `Free handles up to ${FREE_LIMITS.batchImages} images per run. Pro has no limit.`,
        ],
      },
    ],
  },
  {
    id: 'pro',
    title: 'Pro',
    intro: 'One payment, once. Everything above is already in Free.',
    items: [
      {
        id: 'watermark',
        name: 'No watermark',
        platform: BOTH,
        body: [
          `Free exports carry a small "${WATERMARK_TEXT}" mark in the bottom-right corner. Pro removes it.`,
        ],
      },
      {
        id: 'brand-mark',
        name: 'Your own brand mark',
        platform: BOTH,
        body: [
          'Put your logo or a line of text in that corner instead of ours. It is drawn on every export.',
        ],
      },
      {
        id: 'limits',
        name: 'No limits',
        platform: BOTH,
        body: [
          `Unlimited saved presets (Free keeps ${FREE_LIMITS.presets}) and unlimited batch beautify (Free handles ${FREE_LIMITS.batchImages} images per run).`,
        ],
      },
      {
        id: 'updates',
        name: 'A year of updates',
        platform: BOTH,
        body: [
          'Keep every version released within a year of purchase, forever. Versions released later run as Free and say so on screen. The last version your key covers stays Pro.',
        ],
      },
      {
        id: 'activation',
        name: 'Offline activation',
        platform: BOTH,
        body: [
          'A key is checked on your device against a public key built into the app. Activating it sends nothing anywhere, and works without a connection.',
        ],
      },
    ],
  },
];
