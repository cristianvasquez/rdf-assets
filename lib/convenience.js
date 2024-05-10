import rdf from 'rdf-ext'
import { toString, TRIG, TURTLE } from './outputs.js'

const ns = {
  schema: rdf.namespace('http://schema.org/'),
  rdf: rdf.namespace('http://www.w3.org/1999/02/22-rdf-syntax-ns#'),
  xsd: rdf.namespace('http://www.w3.org/2001/XMLSchema#'),
  rdfs: rdf.namespace('http://www.w3.org/2000/01/rdf-schema#'),
}

function toPlainPrefixes (prefixes = ns) {
  const result = {}
  for (const [key, value] of Object.entries({ ...prefixes })) {
    result[key] = value().value
  }
  return result
}

async function prettyPrintTurtle ({ ns, dataset }) {
  return await toString([{ dataset }],
    { format: TURTLE, prefixes: toPlainPrefixes(ns) })
}

async function prettyPrintTrig ({ ns, dataset }) {
  return await toString([{ dataset }],
    { format: TRIG, prefixes: toPlainPrefixes(ns) })
}

export { prettyPrintTrig, prettyPrintTurtle }
