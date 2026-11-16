import { register } from 'node:module'

register(new URL('./jsx-loader.mjs', import.meta.url).href, import.meta.url)
