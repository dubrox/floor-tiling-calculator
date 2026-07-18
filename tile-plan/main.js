import { createRoot } from 'react-dom/client';
import { createElement } from 'react';
import { App } from './App.js';

const root = document.getElementById('root');
createRoot(root).render(createElement(App));
