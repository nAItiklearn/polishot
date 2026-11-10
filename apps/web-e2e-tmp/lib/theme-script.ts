/** Shared between the server layout (inline script) and the client theme store. No React imports here. */
export const THEME_STORAGE_KEY = 'ps-theme';

/**
 * Runs before first paint so there is no flash of the wrong theme.
 * A constant string: no user data is ever interpolated into it.
 */
export const THEME_INIT_SCRIPT = `try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='light'||t==='dark')document.documentElement.setAttribute('data-theme',t)}catch(e){}`;
