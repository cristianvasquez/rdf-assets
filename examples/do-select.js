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
