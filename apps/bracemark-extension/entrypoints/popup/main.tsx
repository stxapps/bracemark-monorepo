import React from 'react';
import ReactDOM from 'react-dom/client';

import { setArgon2Runner } from '@stxapps/web-crypto';

import App from './App.tsx';

import '@/styles/globals.css';

import { Providers } from '@/contexts/providers';

// Run the sign-in Argon2id KDF on the popup's main thread, not in a worker. wxt's dev
// server serves the module worker cross-origin (http://localhost) to this
// chrome-extension:// popup, which hard-crashes the popup renderer; the popup does
// nothing else during sign-in, so a brief main-thread block is the right trade. Must be
// set before any sign-in (SignIn → useSignIn → unlockAccount) can run.
setArgon2Runner('main');

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Popup root element #root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Providers>
      <App />
    </Providers>
  </React.StrictMode>,
);
