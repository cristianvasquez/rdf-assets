import { getAssets, toFile, toString, TRIG } from '../index.js'

const prefixes = { 'ex': 'http://example.org/' }

const assets = await getAssets({ globPattern: './examples/**/*.{ttl,rdf}' })

// await toFile(assets, 'bundle.trig', { format: TRIG, prefixes })
console.log(await toString(assets, { format: TRIG, prefixes }))

/**
 * Outputs:
 *
 * @prefix ex: <http://example.org/> .
 *
 * <file://examples/data/bob-likes-alice.ttl> {
 *         ex:Bob <http://xmlns.com/foaf/0.1/name> "Bob" ;
 *                 a <http://xmlns.com/foaf/0.1/Person> ;
 *                 ex:likes ex:Alice .
 * }
 *
 * <file://examples/data/alice-knows-bob.rdf> {
 *         ex:Alice a <http://xmlns.com/foaf/0.1/Person> ;
 *                 <http://xmlns.com/foaf/0.1/name> "Alice" ;
 *                 <http://xmlns.com/foaf/0.1/knows> ex:Bob .
 *
 *         ex:Bob a <http://xmlns.com/foaf/0.1/Person> .
 * }
 */
