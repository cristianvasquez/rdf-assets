import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import test from 'node:test'
import rdf from 'rdf-ext'
import { pipeline, sinks, sources, transforms } from 'rdf-cli'

test('public api exposes namespace exports', () => {
  assert.equal(typeof sources.readFromGlob, 'function')
  assert.equal(typeof transforms.materialize, 'function')
  assert.equal(typeof transforms.select, 'function')
  assert.equal(typeof transforms.skolemize, 'function')
  assert.equal(typeof sinks.triplify, 'function')
  assert.equal(typeof sinks.datasetToString, 'function')
  assert.equal(typeof pipeline.pipe, 'function')
  assert.equal(typeof pipeline.requireConformance, 'function')
})

test('public api does not expose top-level pipeline components', async () => {
  const api = await import('rdf-cli')
  assert.equal('readFromGlob' in api, false)
  assert.equal('assignGraph' in api, false)
  assert.equal('NQUADS' in api, false)
})

test('public api exposes a dedicated triplify entry point', async () => {
  const { triplify } = await import('rdf-cli/triplify')
  assert.equal(typeof triplify, 'function')
})

test('public api supports composed pipeline usage', async () => {
  const source = sources.readFromGlob(['tests/fixtures/person-valid.ttl'])
  const transformed = Readable.from(source, { objectMode: true }).pipe(transforms.assignGraph('urn:graph'))
  const dataset = await rdf.dataset().import(transformed)
  const output = await sinks.datasetToString(dataset, { format: sinks.TRIG, prefixes: {} })

  assert.ok(output.includes('<urn:graph> {'))
})
