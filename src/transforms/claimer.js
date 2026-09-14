// One claimer per document, applied once per process — the cascade IS the
// Unix pipe (spec/manifest.hs: 'Claimer', 'applyClaimer', 'emitClaimer').
//
// A claimer pairs one claim (SHACL shapes) with a fan-out of named views,
// each of which is a CHAIN of SPARQL CONSTRUCTs (usually of length one). Claimed/rest is marked by graph terms, reusing the
// graph policy: the working set is the GRAPHLESS subset of the incoming
// stream; quads that already carry a named graph were claimed upstream and
// pass through untouched; claiming moves OWNED quads out of graphless space
// (source graph, view graphs) and the rest stays graphless for the next
// claimer in the pipe. Precedence is therefore pipe order, by construction —
// no order metadata exists. Making named data claimable is explicit: pipe
// `rdf graph-drop` first.
//
// A claim also BORROWS a frontier (claim.js): the quads its target navigation
// read, e.g. rdf:type. The frontier feeds the views but stays graphless in
// the rest, so shared navigation vocabulary never starves later claimers;
// copies land in the :frontier graph for provenance.
import { Readable } from 'node:stream'
import rdf from 'rdf-ext'
import { claim } from './claim.js'
import { materialize, construct, chainConstructs } from './sparql.js'

// view metadata predicates for the TriG claimer document 'loadClaimer' parses
// (same urn:rdf-cli:* convention as scripts/manifest.js).
//
// cascade:query is one CONSTRUCT. cascade:queries is an RDF LIST of them, run
// as a chain (spec/manifest.hs: 'chainConstructs') — order matters there, and
// a list is the only thing in RDF that carries order, which is exactly why the
// single-query form cannot just be repeated.
const CLAIMER_NS = 'urn:rdf-cli:cascade#'
const VIEW_QUERY = `${CLAIMER_NS}query`
const VIEW_QUERIES = `${CLAIMER_NS}queries`
const RDF_FIRST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#first'
const RDF_REST = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#rest'
const RDF_NIL = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#nil'

// Parse a claimer document: exactly ONE named graph (the claimer), holding
// the shapes plus the views. Each view is a subject carrying either a
// cascade:query (one CONSTRUCT) or a cascade:queries list (a chain); the
// subject IRI names the graph its output lands in. Views are sorted by IRI —
// the fan-out is commutative, sorting only keeps the wire deterministic.
//
// A malformed document is rejected rather than half-read. Everything here is
// authored by hand, so a silent truncation would show up much later as a
// missing arrow in a drawing rather than as a parse error.
export function loadClaimer (quads, factory = rdf) {
  const all = [...quads]
  const graphs = new Map()
  for (const quad of all) {
    if (quad.graph.termType === 'DefaultGraph') continue
    graphs.set(quad.graph.value, quad.graph)
  }
  if (graphs.size !== 1) {
    throw new Error(
      `a claimer document defines exactly one claimer (one named graph); found ${graphs.size}`)
  }
  const [graph] = graphs.values()

  const objectsOf = (subject, predicate) => all.
    filter((quad) => quad.subject.equals(subject) && quad.predicate.value === predicate).
    map((quad) => quad.object)

  // Walk an RDF list of query literals, in list order, collecting the cells
  // themselves so they can be kept out of the shapes below. `seen` is what
  // stops a cyclic rest-chain: without it the walk grows an array until V8
  // refuses, several seconds later, with an error naming nothing useful.
  const queryList = (head) => {
    const queries = []
    const cells = []
    const seen = new Set()
    let cell = head
    while (cell.value !== RDF_NIL) {
      if (seen.has(cell.value)) {
        throw new Error('a cascade:queries list is cyclic')
      }
      seen.add(cell.value)
      cells.push(cell)

      const first = objectsOf(cell, RDF_FIRST)
      if (first.length !== 1) {
        throw new Error(
          `a cascade:queries list cell needs exactly one rdf:first; found ${first.length}`)
      }
      queries.push(first[0].value)

      const rest = objectsOf(cell, RDF_REST)
      if (rest.length !== 1) {
        throw new Error(
          `a cascade:queries list cell needs exactly one rdf:rest; found ${rest.length}`)
      }
      cell = rest[0]
    }
    return { queries, cells }
  }

  // The list cells carry the query text, so they are claimer metadata just as
  // much as the cascade:* predicates are — but they are spelled in rdf:, which
  // the namespace filter below cannot see. Collect them here and exclude them
  // explicitly, or multi-KB SPARQL literals end up in the dataset handed to
  // the SHACL engine as if they were shapes.
  const listCells = new Set()

  const views = all.
    filter((quad) => quad.predicate.value === VIEW_QUERY ||
      quad.predicate.value === VIEW_QUERIES).
    map((quad) => {
      if (quad.subject.termType !== 'NamedNode') {
        throw new Error('a view subject must be an IRI: it names the output graph')
      }
      let queries
      if (quad.predicate.value === VIEW_QUERIES) {
        const walked = queryList(quad.object)
        queries = walked.queries
        for (const cell of walked.cells) listCells.add(cell.value)
      } else {
        queries = [quad.object.value]
      }
      if (queries.length === 0) {
        throw new Error(`view ${quad.subject.value} declares an empty cascade:queries list`)
      }
      return { graph: quad.subject, queries }
    }).
    sort((left, right) => left.graph.value.localeCompare(right.graph.value))

  // Two views writing the same graph would be silently merged by emitClaimer,
  // and the sort could not order them. The usual cause is a subject carrying
  // both cascade:query and cascade:queries.
  const byGraph = new Set()
  for (const view of views) {
    if (byGraph.has(view.graph.value)) {
      throw new Error(
        `two views name the same output graph: ${view.graph.value}`)
    }
    byGraph.add(view.graph.value)
  }

  const shapes = factory.dataset(all.
    filter((quad) => !quad.predicate.value.startsWith(CLAIMER_NS) &&
      !listCells.has(quad.subject.value)).
    map((quad) => factory.quad(quad.subject, quad.predicate, quad.object)))

  return { graph, shapes, views }
}

// `graph:source` — where a claimer's owned input is preserved for provenance.
export function sourceGraphOf (graphIri) {
  return `${graphIri}:source`
}

// `graph:frontier` — provenance COPIES of the borrowed quads the views were
// fed beyond the source (source ∪ frontier = exactly the view inputs). The
// borrowed originals stay graphless in the rest.
export function frontierGraphOf (graphIri) {
  return `${graphIri}:frontier`
}

// Fan-out law (spec 'projectView'): every view reads the SAME feed (owned
// quads plus the borrowed frontier) — independent queries, each deduped into
// a dataset. An empty result means "this view matched nothing"; the view
// still emits.
//
// A view's own queries are a CHAIN (spec 'chainConstructs'): step n+1 sees
// only step n's output. The two operations compose without either law giving
// way — views still commute with each other, because the chain is contained
// inside one view and never crosses to another.
//
// The single-query case keeps the shared materialization it always had; only
// a chain pays for the extra stores its later steps need.
async function runViews (views, feed, factory) {
  if (views.length === 0) return []
  const store = await materialize(feed)
  const results = []
  for (const view of views) {
    const [first, ...rest] = view.queries
    const output = rest.length === 0
      ? construct(store, first)
      : await chainConstructs(rest, construct(store, first))
    const quads = []
    for await (const quad of output) {
      quads.push(factory.quad(quad.subject, quad.predicate, quad.object))
    }
    results.push({ graph: view.graph, quads: factory.dataset(quads) })
  }
  return results
}

// Apply one claimer to the wire: split off the graphless working set, claim
// from it, fan the views out over owned ∪ borrowed. Laws (spec 'ClaimSplit'):
// claimed ∪ rest = working, claimed ∩ rest = ∅, frontier ⊆ rest — sound
// because the working set is graphless by construction here.
export async function applyClaimer ({ inputQuads, claimer, factory = rdf }) {
  const working = factory.dataset()
  const passThrough = []
  for await (const quad of inputQuads) {
    if (quad.graph.termType === 'DefaultGraph') working.add(quad)
    else passThrough.push(quad)
  }

  const { claimed, frontier, remaining } = await claim({ shapes: claimer.shapes, working, factory })
  const feed = factory.dataset([...claimed, ...frontier])
  const views = await runViews(claimer.views, feed, factory)
  return { claimer, claimed, frontier, views, rest: remaining, passThrough }
}

function * emitQuads ({ claimer, claimed, frontier, views, rest, passThrough }, factory) {
  yield * passThrough

  const sourceGraph = factory.namedNode(sourceGraphOf(claimer.graph.value))
  for (const quad of claimed) {
    yield factory.quad(quad.subject, quad.predicate, quad.object, sourceGraph)
  }

  // provenance copies; the borrowed originals go out graphless with the rest
  const frontierGraph = factory.namedNode(frontierGraphOf(claimer.graph.value))
  for (const quad of frontier) {
    yield factory.quad(quad.subject, quad.predicate, quad.object, frontierGraph)
  }

  for (const { graph, quads } of views) {
    for (const quad of quads) {
      yield factory.quad(quad.subject, quad.predicate, quad.object, graph)
    }
  }

  yield * rest
}

// Serialize the wire channels (passThrough ‖ source ‖ frontier ‖ views ‖ rest)
// into one QuadStream — the same stream shape every other transform produces.
export function emitClaimer (result, { factory = rdf } = {}) {
  return Readable.from(emitQuads(result, factory), { objectMode: true })
}
