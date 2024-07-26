import { Store } from 'oxigraph'
import rdf from 'rdf-ext'
import pkg from 'sparqljs'

const { Parser } = pkg

function createTriplestore ({ assets }) {
  const store = new Store()
  for (const { dataset } of assets.filter(x => x.dataset)) {
    for (const quad of [...dataset]) {
      try {
        store.add(quad)
      } catch (error) {
        // Oxygraph don't accept some quads
        // Quad {
        //   subject: NamedNode { value: 'http://www.w3.org/ns/locn' },
        //   predicate: NamedNode { value: 'http://xmlns.com/foaf/0.1/depiction' },
        //   object: NamedNode { value: 'locn.svg' },
        // }
        console.warn('failed to add', quad, error)
      }
    }
  }
  return store
}

const validateQuery = (query) => new Parser().parse(query) // Oxygraph does not validate queries

function doSelect ({ store, query }) {

  validateQuery(query)
  const result = []
  for (const binding of store.query(query)) {
    const item = Object.fromEntries(binding)
    for (const [varName, term] of Object.entries(item)) {
      item[varName] = termInstance(term)
    }
    result.push(item)
  }
  console.log(`store size: ${store.size}, result length: ${result.length}`)
  return result
}

function doConstruct ({ store, query }) {
  validateQuery(query)
  const result = rdf.dataset()
  for (const current of store.query(query)) {
    const quad = rdf.quad(termInstance(current.subject),
      termInstance(current.predicate), termInstance(current.object), rdf.defaultGraph())
    result.add(quad)
  }
  console.log(`store size: ${store.size}, result size: ${result.size}`)
  return result
}

// Used to defeat Oxygraph bug, hangs when invoking .value multiple times.
// TODO report a github issue
function termInstance (term) {
  if (term.termType === 'Literal') {
    return rdf.literal(term.value, term.language || term.datatype)
  } else if (term.termType === 'NamedNode') {
    return rdf.namedNode(term.value)
  } else if (term.termType === 'BlankNode') {
    return rdf.blankNode(term.value)
  } else if (term.termType === 'DefaultGraph') {
    return rdf.defaultGraph()
  } else {
    // Handle other RDF term types as needed
    return term
  }
}

export { createTriplestore, doSelect, doConstruct }
