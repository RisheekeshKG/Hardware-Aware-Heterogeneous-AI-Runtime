import { createRoot } from 'react-dom/client'
// Fonts ship with the app so the UI looks the same offline.
import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-500.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/manrope/latin-700.css'
import '@fontsource/manrope/latin-800.css'
import '@fontsource/dm-mono/latin-400.css'
import '@fontsource/dm-mono/latin-500.css'
import './styles/index.css'
import { App } from './App.jsx'

createRoot(document.getElementById('root')).render(<App />)
