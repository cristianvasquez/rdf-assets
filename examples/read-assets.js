import { getAssets } from '../index.js'

const assets = await getAssets({ globPattern: './examples/**/*.{ttl,rdf}' })

for (const { path, dataset, error } of assets) {
  console.log(`${path}:`)
  if (dataset) {
    console.log(`\tcontents: ${dataset.size} quads`)
  } else if (error) {
    console.log(`\terror: ${error}`)
  }
}
