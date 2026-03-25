import { createApp } from 'vue'
import App from './App.vue'
import router from './router.js'
import './styles.css'
import { initializeI18n } from './composables/useI18n.js'
import { initializeTheme } from './composables/useTheme.js'

initializeTheme()
initializeI18n()

createApp(App).use(router).mount('#app')
