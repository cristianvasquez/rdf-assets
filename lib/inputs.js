import formats from '@rdfjs/formats'
import fs from 'fs'
import rdf from 'rdf-ext'
import { applyGlob } from './find.js'

const mimeTypes = {
  '.jsonld': 'application/ld+json',
  '.trig': 'application/trig',
  '.nq': 'application/n-quads',
  '.nt': 'application/n-triples',
  '.n3': 'text/n3',
  '.ttl': 'text/turtle',
  '.rdf': 'application/rdf+xml',
}

function guessMimetype (filePath) {
  const ext = filePath.slice(filePath.lastIndexOf('.'))
  return mimeTypes[ext]
}

const defaultGraph = (path) => rdf.defaultGraph()

async function parseFile (path, graphFactory = defaultGraph) {
  const fileStream = fs.createReadStream(path, 'utf-8')
  const dataset = rdf.dataset()
  try {
    const mimeType = guessMimetype(path)
    if (!mimeType) {
      return { path, error: `I don't know how to parse` }
    }
    await dataset.import(formats.parsers.import(mimeType, fileStream))
    for (const quad of [...dataset]) {
      quad.graph = graphFactory(path)
    }
    return { path, dataset }
  } catch (error) {
    return { path, error }
  }
}

const pathAsGraph = (path) => rdf.namedNode(`file://${path}`)

async function getAssets (
  { globPattern }, graphFactory = pathAsGraph) {
  const files = await applyGlob(globPattern)
  const promises = files.map(filePath => parseFile(filePath, graphFactory))
  return await Promise.all(promises)
}

export { parseFile, getAssets }
