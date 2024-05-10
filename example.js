import { getAssets } from './lib/inputs.js'
import { toString, TURTLE } from './lib/outputs.js'

const prefixes = { 'ex': 'http://example.org/' }

const assets = await getAssets({ globPattern: './example/**/*' })
const str = await toString(assets, { format: TURTLE, prefixes })

console.log(str)
