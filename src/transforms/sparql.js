import { Store } from 'oxigraph'
import { Readable } from 'node:stream'
import rdf from 'rdf-ext'

const MATERIALIZE_STATS = Symbol('rdf-cli.materialize.stats')

export function getMaterializeStats (store) {
  return store?.[MATERIALIZE_STATS] ?? {
    quadsIn: store?.size ?? 0,
    quadsOut: store?.size ?? 0,
    droppedIn: 0,
  }
}

function termInstance (term) {
  if (term.termType === 'Literal')
    return rdf.literal(term.value, term.language || term.datatype)
  if (term.termType === 'NamedNode') return rdf.namedNode(term.value)
  if (term.termType === 'BlankNode') return rdf.blankNode(term.value)
  if (term.termType === 'DefaultGraph') return rdf.defaultGraph()
  return term
}

// Drain a quad stream into an oxigraph store. This is the single materialization
// point: one store can then feed many query ops instead of each op re-draining.
export async function materialize (source) {
  const store = new Store()
  let quadsIn = 0
  let dropped = 0
  for await (const quad of source) {
    quadsIn++
    try {
      store.add(quad)
    } catch {
      dropped++
    }
  }
  if (dropped > 0) process.stderr.write(`warning: dropped ${dropped} quads\n`)
  Object.defineProperty(store, MATERIALIZE_STATS, {
    value: { quadsIn, quadsOut: store.size, droppedIn: dropped },
  })
  return store
}

// Copy a store back into an rdf-ext dataset (e.g. for shacl-engine, which needs a
// dataset rather than a SPARQL store). Terms are re-instantiated as rdf-ext terms.
export function storeToDataset (store) {
  const dataset = rdf.dataset()
  for (const quad of store.match()) {
    dataset.add(
      rdf.quad(
        termInstance(quad.subject),
        termInstance(quad.predicate),
        termInstance(quad.object),
        termInstance(quad.graph),
      ),
    )
  }
  return dataset
}

function * constructQuads (store, query) {
  for (const triple of store.query(query)) {
    yield rdf.quad(
      termInstance(triple.subject),
      termInstance(triple.predicate),
      termInstance(triple.object),
      rdf.defaultGraph(),
    )
  }
}

function * selectBindings (store, query) {
  for (const binding of store.query(query)) {
    const row = Object.fromEntries(binding)
    for (const [key, value] of Object.entries(row)) row[key] = termInstance(value)
    yield row
  }
}

// SPARQL CONSTRUCT over a materialized store. Output is graphless.
export function construct (store, query) {
  return Readable.from(constructQuads(store, query), { objectMode: true })
}

// SPARQL SELECT over a materialized store. Leaves RDF space, yields bindings rows.
export function select (store, query) {
  return selectBindings(store, query)
}

// Sequential CONSTRUCT pipeline (spec/manifest.hs: 'chainConstructs') — the
// Kleisli-composition monoid, and the DIFFERENT operation from a claimer's
// view fan-out ('runViews' is traverse in a commuting applicative). Order is
// significant and step n+1 sees ONLY step n's output, so a step that wants to
// keep something has to re-emit it. That is the whole boundary: what one step
// hands the next is exactly what it CONSTRUCTs, nothing implicit.
//
// The spec declared this unimplemented because the CLI already covers it by
// piping `rdf construct`. In-process there is no pipe, so the library needs
// it: it is what lets one derivation be computed once and then USED, instead
// of being repeated at every site that needs it.
//
// Each step gets a fresh store because a step's output replaces its input; an
// empty chain is the identity.
//
// Precondition: graphless input. Every step's WHERE runs against the default
// graph and `construct` emits graphless, so a named-graph quad would be
// dropped at the first step. Inside a claimer that holds by construction (the
// working set is the graphless subset of the wire); a direct caller that has
// named data pipes `dropGraph` first, the same rule claiming itself follows.
export async function chainConstructs (queries, quads) {
  let current = quads
  for (const query of queries) {
    const store = await materialize(current)
    current = construct(store, query)
  }
  return current
}
