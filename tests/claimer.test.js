import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import rdf from 'rdf-ext'
import {
  loadClaimer, applyClaimer, emitClaimer, sourceGraphOf, frontierGraphOf,
} from '../src/transforms/claimer.js'
import { chainConstructs } from '../src/transforms/sparql.js'

const ns = (s) => rdf.namedNode(`http://example.org/${s}`)
const SH = (s) => rdf.namedNode(`http://www.w3.org/ns/shacl#${s}`)
const RDF_TYPE = rdf.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type')
const QUERY = rdf.namedNode('urn:rdf-cli:cascade#query')

const personGraph = ns('claimers/person')
const upstreamGraph = ns('already/claimed')

// Person claimer: owns Person name quads (constraint read), borrows the type
// quads (target navigation). Two views — one derives a label, one matches
// nothing in the input below.
function personClaimerQuads () {
  return [
    rdf.quad(ns('PersonShape'), RDF_TYPE, SH('NodeShape'), personGraph),
    rdf.quad(ns('PersonShape'), SH('targetClass'), ns('Person'), personGraph),
    rdf.quad(ns('PersonShape'), SH('property'), ns('p1'), personGraph),
    rdf.quad(ns('p1'), SH('path'), ns('name'), personGraph),
    rdf.quad(ns('views/card'), QUERY, rdf.literal(
      'CONSTRUCT { ?p <http://example.org/label> ?n } WHERE { ?p <http://example.org/name> ?n }'), personGraph),
    rdf.quad(ns('views/timeline'), QUERY, rdf.literal(
      'CONSTRUCT { ?p <http://example.org/event> ?e } WHERE { ?p <http://example.org/born> ?e }'), personGraph),
  ]
}

const looseGraph = ns('claimers/loose-ends')

// Bare navigation-only claimer: targets subjects of ex:unrelated but never
// reads anything with a constraint — it borrows, it owns nothing.
function bareLooseClaimerQuads () {
  return [
    rdf.quad(ns('LooseShape'), RDF_TYPE, SH('NodeShape'), looseGraph),
    rdf.quad(ns('LooseShape'), SH('targetSubjectsOf'), ns('unrelated'), looseGraph),
  ]
}

// The opt-in ownership idiom: an explicit constraint reading the target quads
// lands them in coverage, so the claimer takes them.
function owningLooseClaimerQuads () {
  return [
    ...bareLooseClaimerQuads(),
    rdf.quad(ns('LooseShape'), SH('property'), ns('looseP'), looseGraph),
    rdf.quad(ns('looseP'), SH('path'), ns('unrelated'), looseGraph),
  ]
}

// Two graphless Person quads, one graphless loose quad, one quad already
// claimed upstream (named graph).
function inputQuads () {
  return [
    rdf.quad(ns('alice'), RDF_TYPE, ns('Person')),
    rdf.quad(ns('alice'), ns('name'), rdf.literal('Alice')),
    rdf.quad(ns('x'), ns('unrelated'), ns('y')),
    rdf.quad(ns('u'), ns('untouchable'), ns('v'), upstreamGraph),
  ]
}

async function collect (stream) {
  const quads = []
  for await (const q of stream) quads.push(q)
  return quads
}

test('loadClaimer parses one claimer: graph, shapes, views sorted by IRI', () => {
  const claimer = loadClaimer(personClaimerQuads())
  assert.ok(claimer.graph.equals(personGraph))
  assert.equal(claimer.shapes.size, 4, 'shapes exclude cascade# metadata')
  assert.deepEqual(claimer.views.map((v) => v.graph.value),
    [ns('views/card').value, ns('views/timeline').value])
})

test('loadClaimer rejects a document with two claimers', () => {
  assert.throws(() => loadClaimer([...personClaimerQuads(), ...bareLooseClaimerQuads()]),
    /exactly one claimer.*found 2/)
})

test('loadClaimer rejects a document with no claimer', () => {
  assert.throws(() => loadClaimer(inputQuads().slice(0, 2)), /found 0/)
})

test('loadClaimer rejects a non-IRI view subject', () => {
  const quads = [...bareLooseClaimerQuads(),
    rdf.quad(rdf.blankNode(), QUERY, rdf.literal('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }'), looseGraph)]
  assert.throws(() => loadClaimer(quads), /view subject must be an IRI/)
})

test('applyClaimer splits the working set: partition, disjointness, borrowed frontier', async () => {
  const claimer = loadClaimer(personClaimerQuads())
  const { claimed, frontier, rest } = await applyClaimer({ inputQuads: inputQuads(), claimer })

  assert.equal(claimed.size, 1, 'owned: the constraint-read name quad')
  assert.equal(frontier.size, 1, 'borrowed: the target-navigation type quad')
  assert.equal(rest.size, 2, 'type (borrowed, stays) and the loose quad')

  const graphless = inputQuads().filter((q) => q.graph.termType === 'DefaultGraph')
  const union = rdf.dataset([...claimed, ...rest])
  assert.equal(union.size, graphless.length, 'claimed ∪ rest = working set')
  for (const quad of claimed) assert.ok(!rest.has(quad), 'claimed ∩ rest = ∅')
  for (const quad of frontier) assert.ok(rest.has(quad), 'frontier ⊆ rest')
})

test('applyClaimer passes named-graph quads through untouched', async () => {
  const claimer = loadClaimer(personClaimerQuads())
  const { passThrough } = await applyClaimer({ inputQuads: inputQuads(), claimer })
  assert.equal(passThrough.length, 1)
  assert.ok(passThrough[0].graph.equals(upstreamGraph))
})

test('every view reads the same feed; a view matching nothing stays present, empty', async () => {
  const claimer = loadClaimer(personClaimerQuads())
  const { views } = await applyClaimer({ inputQuads: inputQuads(), claimer })
  assert.equal(views.length, 2)
  assert.equal(views[0].quads.size, 1, 'card view derives the label')
  assert.equal(views[1].quads.size, 0, 'timeline view matched nothing but is still present')
})

test('views read the borrowed frontier too', async () => {
  const quads = [
    ...personClaimerQuads().filter((q) => !q.predicate.equals(QUERY)),
    rdf.quad(ns('views/types'), QUERY, rdf.literal(
      'CONSTRUCT { ?p <http://example.org/isA> ?c } WHERE { ?p a ?c }'), personGraph),
  ]
  const claimer = loadClaimer(quads)
  const { views } = await applyClaimer({ inputQuads: inputQuads(), claimer })
  assert.equal(views[0].quads.size, 1, 'view derived from the borrowed type quad')
})

test('a navigation-only claimer borrows but owns nothing', async () => {
  const claimer = loadClaimer(bareLooseClaimerQuads())
  assert.deepEqual(claimer.views, [])
  const { claimed, frontier } = await applyClaimer({ inputQuads: inputQuads(), claimer })
  assert.equal(claimed.size, 0, 'no constraint read anything — nothing owned')
  assert.equal(frontier.size, 1, 'the target quad is only borrowed')
})

test('ownership of target quads is opt-in via an explicit constraint', async () => {
  const claimer = loadClaimer(owningLooseClaimerQuads())
  const { claimed, frontier } = await applyClaimer({ inputQuads: inputQuads(), claimer })
  assert.equal(claimed.size, 1, 'sh:path ex:unrelated lands the quad in coverage')
  assert.equal(frontier.size, 0, 'owned quads are not borrowed')
})

test('emitClaimer routes the channels: pass-through, source, frontier, views, graphless rest', async () => {
  const claimer = loadClaimer(personClaimerQuads())
  const result = await applyClaimer({ inputQuads: inputQuads(), claimer })
  const emitted = await collect(emitClaimer(result))

  const byGraph = (iri) => emitted.filter((q) => q.graph.value === iri)
  assert.equal(byGraph(upstreamGraph.value).length, 1, 'upstream claim untouched')
  assert.equal(byGraph(sourceGraphOf(personGraph.value)).length, 1, 'owned quad in source graph')
  assert.equal(byGraph(frontierGraphOf(personGraph.value)).length, 1, 'borrowed copy in frontier graph')
  assert.equal(byGraph(ns('views/card').value).length, 1, 'view quads in the view graph')
  const graphless = emitted.filter((q) => q.graph.termType === 'DefaultGraph')
  assert.equal(graphless.length, 2, 'rest (incl. borrowed original) stays graphless')
})

test('a later claimer in the pipe cannot take an earlier claimer\'s quads', async () => {
  const person = loadClaimer(personClaimerQuads())
  const loose = loadClaimer(owningLooseClaimerQuads())

  const afterPerson = await applyClaimer({ inputQuads: inputQuads(), claimer: person })
  const afterLoose = await applyClaimer({
    inputQuads: emitClaimer(afterPerson), claimer: loose,
  })

  assert.equal(afterLoose.claimed.size, 1, 'owns the loose quad from the graphless rest')
  assert.equal(afterLoose.rest.size, 1, 'the borrowed type quad remains graphless')
  // person's source + frontier copy + view quad plus the upstream claim arrive named
  assert.equal(afterLoose.passThrough.length, 4, 'earlier claims pass through untouchable')

  const emitted = await collect(emitClaimer(afterLoose))
  const graphs = new Set(emitted.map((q) => q.graph.value))
  assert.ok(graphs.has(sourceGraphOf(personGraph.value)))
  assert.ok(graphs.has(sourceGraphOf(looseGraph.value)))
})

test('regression: two claimers over the same class both claim their content', async () => {
  // both target ex:Person, read different properties — the borrowed frontier
  // keeps the shared type quad available to the second claimer
  function metaphor (name, path) {
    const g = ns(`claimers/${name}`)
    return loadClaimer([
      rdf.quad(ns(`${name}Shape`), RDF_TYPE, SH('NodeShape'), g),
      rdf.quad(ns(`${name}Shape`), SH('targetClass'), ns('Person'), g),
      rdf.quad(ns(`${name}Shape`), SH('property'), ns(`${name}P`), g),
      rdf.quad(ns(`${name}P`), SH('path'), ns(path), g),
    ])
  }
  const input = [
    rdf.quad(ns('alice'), RDF_TYPE, ns('Person')),
    rdf.quad(ns('alice'), ns('name'), rdf.literal('Alice')),
    rdf.quad(ns('alice'), ns('born'), rdf.literal('1990')),
  ]

  const afterCard = await applyClaimer({ inputQuads: input, claimer: metaphor('card', 'name') })
  assert.equal(afterCard.claimed.size, 1, 'card owns the name quad')

  const afterTimeline = await applyClaimer({
    inputQuads: emitClaimer(afterCard), claimer: metaphor('timeline', 'born'),
  })
  assert.equal(afterTimeline.claimed.size, 1, 'timeline still finds Person targets and owns born')
  assert.equal(afterTimeline.rest.size, 1, 'the shared type quad is owned by nobody')
  assert.ok([...afterTimeline.rest][0].predicate.equals(RDF_TYPE))
})

// ---------------------------------------------------------------------------
// chainConstructs: the sequential operation, and how a view uses it.
// The point of the chain is to derive something ONCE and then use it, instead
// of repeating the derivation at every site that needs it. Its defining
// property is the one that makes that safe: step n+1 sees only step n's
// output, so what crosses a step boundary is exactly what was CONSTRUCTed.
// ---------------------------------------------------------------------------

const QUERIES = rdf.namedNode('urn:rdf-cli:cascade#queries')
const RDF_FIRST = rdf.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#first')
const RDF_REST = rdf.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#rest')
const RDF_NIL = rdf.namedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#nil')

/** An RDF list of query literals in `graph`, headed at `head`. */
function queryList (head, queries, graph) {
  const quads = []
  queries.forEach((query, index) => {
    const cell = index === 0 ? head : rdf.blankNode(`${head.value}-${index}`)
    const next = index === queries.length - 1
      ? RDF_NIL
      : rdf.blankNode(`${head.value}-${index + 1}`)
    quads.push(rdf.quad(cell, RDF_FIRST, rdf.literal(query), graph))
    quads.push(rdf.quad(cell, RDF_REST, next, graph))
  })
  return quads
}

test('chainConstructs runs its steps in order, each over the last output', async () => {
  const input = [rdf.quad(ns('a'), ns('one'), ns('b'))]
  const out = await collect(await chainConstructs([
    'CONSTRUCT { ?s <http://example.org/two> ?o } WHERE { ?s <http://example.org/one> ?o }',
    'CONSTRUCT { ?s <http://example.org/three> ?o } WHERE { ?s <http://example.org/two> ?o }',
  ], Readable.from(input, { objectMode: true })))

  assert.equal(out.length, 1)
  assert.ok(out[0].predicate.equals(ns('three')), 'the second step consumed the first step output')
})

test('a chain step sees ONLY the previous output, never the original input', async () => {
  // The first step drops `one` by not re-emitting it. If the steps shared a
  // feed, the second step would still find it.
  const input = [rdf.quad(ns('a'), ns('one'), ns('b'))]
  const out = await collect(await chainConstructs([
    'CONSTRUCT { ?s <http://example.org/two> ?o } WHERE { ?s <http://example.org/one> ?o }',
    'CONSTRUCT { ?s <http://example.org/kept> ?o } WHERE { ?s <http://example.org/one> ?o }',
  ], Readable.from(input, { objectMode: true })))

  assert.deepEqual(out, [], 'the original input is gone once a step declines to re-emit it')
})

test('a chain step keeps what it re-emits, which is how a derivation is used', async () => {
  const input = [rdf.quad(ns('a'), ns('one'), ns('b'))]
  const out = await collect(await chainConstructs([
    `CONSTRUCT { ?s ?p ?o . ?s <http://example.org/derived> "yes" }
     WHERE { ?s ?p ?o }`,
    `CONSTRUCT { ?s <http://example.org/used> ?d }
     WHERE { ?s <http://example.org/one> ?o . ?s <http://example.org/derived> ?d }`,
  ], Readable.from(input, { objectMode: true })))

  assert.equal(out.length, 1)
  assert.ok(out[0].predicate.equals(ns('used')))
  assert.equal(out[0].object.value, 'yes', 'step 2 joined the original data against step 1 derivation')
})

test('an empty chain is the identity', async () => {
  const input = [rdf.quad(ns('a'), ns('one'), ns('b'))]
  const out = await collect(await chainConstructs([], Readable.from(input, { objectMode: true })))
  assert.equal(out.length, 1)
  assert.ok(out[0].predicate.equals(ns('one')))
})

test('a view declares a chain with cascade:queries, in list order', async () => {
  const g = ns('claimers/chained')
  const view = ns('views/chained')
  const claimer = loadClaimer([
    rdf.quad(ns('PersonShape'), RDF_TYPE, SH('NodeShape'), g),
    rdf.quad(ns('PersonShape'), SH('targetClass'), ns('Person'), g),
    rdf.quad(ns('PersonShape'), SH('property'), ns('p1'), g),
    rdf.quad(ns('p1'), SH('path'), ns('name'), g),
    rdf.quad(view, QUERIES, rdf.blankNode('list'), g),
    ...queryList(rdf.blankNode('list'), [
      `CONSTRUCT { ?s ?p ?o . ?s <http://example.org/shout> ?n }
       WHERE { ?s ?p ?o . OPTIONAL { ?s <http://example.org/name> ?n } }`,
      `CONSTRUCT { ?s <http://example.org/label> ?n }
       WHERE { ?s <http://example.org/shout> ?n }`,
    ], g),
  ])

  assert.equal(claimer.views.length, 1)
  assert.equal(claimer.views[0].queries.length, 2, 'both list members survive as ordered queries')

  const result = await applyClaimer({
    inputQuads: [
      rdf.quad(ns('alice'), RDF_TYPE, ns('Person')),
      rdf.quad(ns('alice'), ns('name'), rdf.literal('Alice')),
    ],
    claimer,
  })
  const [projected] = result.views
  assert.equal(projected.graph.value, view.value)
  const labels = [...projected.quads].filter((q) => q.predicate.equals(ns('label')))
  assert.equal(labels.length, 1, 'the second query ran over the first query output')
  assert.equal(labels[0].object.value, 'Alice')
})

test('views still commute when one of them is a chain', async () => {
  // The fan-out law must survive the chain: a view never sees another view's
  // output, however many steps it has internally.
  const g = ns('claimers/mixed')
  const quads = [
    rdf.quad(ns('PersonShape'), RDF_TYPE, SH('NodeShape'), g),
    rdf.quad(ns('PersonShape'), SH('targetClass'), ns('Person'), g),
    rdf.quad(ns('PersonShape'), SH('property'), ns('p1'), g),
    rdf.quad(ns('p1'), SH('path'), ns('name'), g),
    rdf.quad(ns('views/plain'), QUERY, rdf.literal(
      'CONSTRUCT { ?s <http://example.org/plain> ?o } WHERE { ?s <http://example.org/name> ?o }'), g),
    rdf.quad(ns('views/chained'), QUERIES, rdf.blankNode('l'), g),
    ...queryList(rdf.blankNode('l'), [
      `CONSTRUCT { ?s <http://example.org/mid> ?o } WHERE { ?s <http://example.org/name> ?o }`,
      `CONSTRUCT { ?s <http://example.org/end> ?o } WHERE { ?s <http://example.org/mid> ?o }`,
    ], g),
  ]
  const result = await applyClaimer({
    inputQuads: [
      rdf.quad(ns('alice'), RDF_TYPE, ns('Person')),
      rdf.quad(ns('alice'), ns('name'), rdf.literal('Alice')),
    ],
    claimer: loadClaimer(quads),
  })

  const byGraph = new Map(result.views.map((v) => [v.graph.value, [...v.quads]]))
  assert.equal(byGraph.get(ns('views/plain').value).length, 1)
  assert.equal(byGraph.get(ns('views/chained').value).length, 1)
  // The chained view's intermediate `mid` must not leak into its own output,
  // and neither view may see the other's predicates.
  assert.ok(byGraph.get(ns('views/chained').value)[0].predicate.equals(ns('end')))
  assert.ok(byGraph.get(ns('views/plain').value)[0].predicate.equals(ns('plain')))
})

test('an empty cascade:queries list is rejected rather than silently drawing nothing', () => {
  const g = ns('claimers/empty')
  assert.throws(() => loadClaimer([
    rdf.quad(ns('S'), RDF_TYPE, SH('NodeShape'), g),
    rdf.quad(ns('views/none'), QUERIES, RDF_NIL, g),
  ]), /empty cascade:queries/)
})
