import '@polishot/brand/tokens.css';
import '@polishot/editor/editor.css';
import './styles/fonts.css';
import './styles/mobile.css';

import { APP_NAME } from '@polishot/brand';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installPolishotApi } from './host';

document.title = APP_NAME;

// Define window.polishot before anything mounts so Android can call it as soon as the page has loaded.
installPolishotApi();

const container = document.getElementById('root');
if (container) createRoot(container).render(<App />);
