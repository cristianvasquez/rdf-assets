# rdf-assets

Say you have several RDF files somewhere in a directory, using several formats.

[example](./example.js):

```js
import { getAssets, toString, TURTLE } from 'rdf-assets'

const prefixes = { 'ex': 'http://example.org/' }

const assets = await getAssets({ globPattern: './example/**/*' })
const str = await toString(assets, { format: TURTLE, prefixes })

console.log(str)
```

Outputs a pretty TURTLE with the contents of such files.
