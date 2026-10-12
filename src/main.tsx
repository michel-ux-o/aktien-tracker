import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './auth/AuthContext';
import App from './App';
import { registerServiceWorker } from './pwa';
import './styles/app.css';

const root = document.getElementById('root');
if (!root) throw new Error('Das Root-Element fehlt.');
createRoot(root).render(<StrictMode><BrowserRouter><AuthProvider><App /></AuthProvider></BrowserRouter></StrictMode>);
registerServiceWorker();
