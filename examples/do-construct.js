import {
  createTriplestore,
  doConstruct,
  getAssets,
  prettyPrintTurtle,
} from '../index.js'

const assets = await getAssets({ globPattern: './examples/**/*.{ttl,rdf}' })

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
 * Outputs:
 *
 * <http://example.org/Alice> a <http://xmlns.com/foaf/0.1/Person> ;
 *         <http://xmlns.com/foaf/0.1/knows> <http://example.org/Bob> ;
 *         <http://xmlns.com/foaf/0.1/name> "Alice" .
 *
 * <http://example.org/Bob> a <http://xmlns.com/foaf/0.1/Person> ;
 *         <http://xmlns.com/foaf/0.1/name> "Bob" ;
 *         <http://example.org/likes> <http://example.org/Alice> .
 */
