import { getAssets, toFile, toString, TRIG } from '../index.js'

const prefixes = { 'ex': 'http://example.org/' }

const assets = await getAssets({ globPattern: './examples/data/**/*' })

// await toFile(assets, 'bundle.trig', { format: TRIG, prefixes })
console.log(await toString(assets, { format: TRIG, prefixes }))
