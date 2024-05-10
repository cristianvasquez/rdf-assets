import {
  TrigSerializer,
  TurtleSerializer,
} from '@rdfjs-elements/formats-pretty'
import fs from 'fs'
import getStream from 'get-stream'
import rdf from 'rdf-ext'
import { Readable } from 'stream'

// Creates a combined stream of RDF quads from the provided assets
async function combineInSink (sink, assets) {
  const combinedStream = new Readable({
    objectMode: true,
    read () {},
  })

  assets.forEach(({ dataset }) => {
    dataset?.forEach(quad => combinedStream.push(quad))
  })

  combinedStream.push(null) // Mark the end of the stream
  return await sink.import(combinedStream)
}

// Returns a stream serialized in Turtle format
async function toTurtleStream (assets, prefixes = {}) {
  const turtleSink = new TurtleSerializer({ prefixes })
  return await combineInSink(turtleSink, assets)
}

// Returns a stream serialized in TriG format
async function toTrigStream (assets, prefixes = {}) {
  const trigSink = new TrigSerializer({ prefixes })
  return await combineInSink(trigSink, assets)
}

async function toNTriplesStream (assets) {
  const nTriplesSink = rdf.formats.serializers.get('application/n-triples')
  return await combineInSink(nTriplesSink, assets)
}

async function writeToFile (stream, outputPath) {
  const fileStream = fs.createWriteStream(outputPath)
  return new Promise((resolve, reject) => {
    stream.on('error', reject).
      pipe(fileStream).
      on('error', reject).
      on('finish', resolve)
  })
}

const TURTLE = 'text/turtle'
const N_TRIPLES = 'application/n-triples'
const TRIG = 'application/trig'

const getStreamFunction = (format) => {
  const options = {
    [TURTLE]: toTurtleStream,
    [N_TRIPLES]: toNTriplesStream,
    [TRIG]: toTrigStream,
  }
  return options[format] || options[TURTLE]
}

// Serializes assets to a stream with given serialization options
async function toStream (assets, { format, prefixes }) {
  const serialize = getStreamFunction(format)
  return await serialize(assets, prefixes)
}

// Converts assets to a string representation using serialization options
async function toString (assets, { format, prefixes }) {
  const stream = await toStream(assets, { format, prefixes })
  return await getStream(stream)
}

// Converts assets to a file using serialization options
async function toFile (assets, outputPath, { format, prefixes }) {
  const stream = await toStream(assets, { format, prefixes })
  await writeToFile(stream, outputPath)
}

export {
  toStream,
  toString,
  toFile,
  TURTLE,
  N_TRIPLES,
  TRIG,
}
