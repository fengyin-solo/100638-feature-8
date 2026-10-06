import { createApp } from 'vue'
import { createPinia } from 'pinia'

import App from './App.vue'
import router from './router'
import { runEnvMigrationOnce } from './domain/env-migration'
import './styles/global.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')

// 存量环境监测记录按下发日期一次性回填（重复报送折叠、脏数据重判、通风联动对账）。
runEnvMigrationOnce()
