import { mount } from 'svelte'
import App from './App.svelte'
import './styles.css'

const root = document.getElementById('root')
if (!root) throw new Error('No #root element')
mount(App, { target: root })
