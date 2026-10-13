/** Entry point: mount <App> into #root. */
import { createRoot } from 'react-dom/client';
import { App } from './components/App.jsx';

createRoot(document.getElementById('root')).render(<App />);
