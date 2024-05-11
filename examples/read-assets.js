import { getAssets } from '../index.js'

const assets = await getAssets({ globPattern: './examples/data/**' })

for (const { path, dataset, error } of assets) {
  console.log(`${path}:`)
  if (dataset) {
    console.log(`\tcontents: ${dataset.size} quads`)
  } else if (error) {
    console.log(`\terror: ${error}`)
  }
}

/**
 Outputs:

 examples/data/wrong-turtle.ttl:
    error: Error: Undefined prefix ":" on line 1.
 examples/data/bob-likes-alice.ttl:
    contents: 3 quads
 examples/data/alice-knows-bob.rdf:
    contents: 4 quads
 examples/data/alice-cat.md:
    error: I don't know how to parse
 */
