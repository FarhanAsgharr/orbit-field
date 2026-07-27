import React from 'react';
import { createRoot } from 'react-dom/client';

import { App } from './App';
import './styles/portal.css';

createRoot(document.querySelector('#root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
