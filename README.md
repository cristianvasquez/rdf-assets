# rdf-assets

Say you have a bunch of RDF files in various formats scattered throughout a directory tree.

Then you can gather and bundle these files into TRIG format by utilizing
a [glob pattern](https://en.wikipedia.org/wiki/Glob_(programming)).

```js
import { getAssets, toFile, TRIG } from '../index.js'

const prefixes = { 'ex': 'http://example.org/' }

const assets = await getAssets({ globPattern: './examples/data/**/*' })

await toFile(assets, 'bundle.trig', { format: TRIG, prefixes })
```

Or you can use SPARQL to query these files:

```js
import { createTriplestore, doSelect, getAssets } from '../index.js'

const assets = await getAssets({ globPattern: './examples/**/*.{ttl,rdf}' })

const store = await createTriplestore({ assets })

const query = `
prefix foaf: <http://xmlns.com/foaf/0.1/>

SELECT ?s ?name
WHERE {
  graph ?g {
       ?s foaf:name ?name .
  }
}
`

const rows = doSelect({ store, query })
console.log(rows)

/**
 * Outputs
 [
     {
         s: NamedNode { value: 'http://example.org/Alice' },
         name: Literal { value: 'Alice', language: '', datatype: [NamedNode] }
     },
     {
         s: NamedNode { value: 'http://example.org/Bob' },
         name: Literal { value: 'Bob', language: '', datatype: [NamedNode] }
     }
 ]
 */

```

Or display the results of a CONSTRUCT serialized in turtle

```js
import {
  createTriplestore,
  doConstruct,
  getAssets,
  prettyPrintTurtle,
} from '../index.js'

const assets = await getAssets({ globPattern: './examples/**/*' })

const store = await createTriplestore({ assets })

const query = `
prefix foaf: <http://xmlns.com/foaf/0.1/>

CONSTRUCT {
  ?s ?p ?o
}
WHERE {
  graph ?g {
       ?s a foaf:Person .
       ?s ?p ?o .
  }
}
`

const dataset = doConstruct({ store, query })
const str = await prettyPrintTurtle({ dataset })
console.log(str)

/**
 * <http://example.org/Alice> a <http://xmlns.com/foaf/0.1/Person> ;
 *         <http://xmlns.com/foaf/0.1/knows> <http://example.org/Bob> ;
 *         <http://xmlns.com/foaf/0.1/name> "Alice" .
 *
 * <http://example.org/Bob> a <http://xmlns.com/foaf/0.1/Person> ;
 *         <http://xmlns.com/foaf/0.1/name> "Bob" ;
 *         <http://example.org/likes> <http://example.org/Alice> .
 */

```

See [examples](./examples) for details

This uses [RDF JavaScript Libraries](https://rdf.js.org/) and [oxygraph](https://github.com/oxigraph/oxigraph) as
in-memory triplestore.
