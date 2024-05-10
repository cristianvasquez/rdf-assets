import { prettyPrintTrig } from './lib/convenience.js'
import { getAssets } from './lib/inputs.js'

const assets = await getAssets({ globPattern: './example/**/*' })

// One by one
for (const { dataset } of assets) {
  if (dataset) {
    const str = await prettyPrintTrig({ dataset })
    console.log(str)
  }
}
