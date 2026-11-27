import '@fontsource-variable/inter'
import './styles/globals.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { initI18n } from './i18n'

// O processo principal ajusta o tema nativo antes de abrir a janela, então o
// `prefers-color-scheme` já reflete a configuração: aplicar a classe aqui, antes
// do primeiro render, evita qualquer flash de tema errado.
const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
document.documentElement.classList.toggle('dark', prefersDark)
document.documentElement.style.colorScheme = prefersDark ? 'dark' : 'light'

initI18n(window.api.initialLanguage)

const container = document.getElementById('root')
if (!container) throw new Error('Elemento #root não encontrado')

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
