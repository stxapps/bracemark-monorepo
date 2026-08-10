import React from 'react';
import ReactDOM from 'react-dom/client';

import App from './App.tsx';

import '@/styles/globals.css';

import { Providers } from '@/contexts/providers';

const rootEl = document.getElementById('root');
if (!rootEl) throw new Error('Options root element #root not found');

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    <Providers>
      <App />
    </Providers>
  </React.StrictMode>,
);
