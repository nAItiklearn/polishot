package app.polishot

// Mirrors packages/brand/src/index.ts, the single source of truth for the product name.
// A brand-sync test in packages/brand greps this file for the quoted product name.
// If you rename the product, change it there first, then here.
const val APP_NAME = "Polishot"
const val APP_SLUG = "polishot"
const val APP_ID = "app.polishot"
const val WATERMARK_TEXT = "Made with $APP_NAME"
