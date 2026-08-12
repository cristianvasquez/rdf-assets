---
uuid: ecf2782d-2017-49d7-8b40-a86ee9a14a7e
repo-group: rdf
tldr: short rationale for the `rdf` CLI shape.
tags: [spec/rdf]
---

# rdf stream algebra

This note explains the design bias behind the CLI. For the actual command contract, see `rdf-cli semantics.md`.

## Why this shape

- The CLI is dataset-first, not quad-first.
- Graphless statements are first-class and should not be turned into named graphs implicitly.
- `read` is the default source command because most pipelines start from RDF files or RDF bytes.
- `from-paths` exists for shell composition when another command is already producing paths.
- Transforms stay in dataset space until a command explicitly exits it.
- Sinks own output formatting.

## Stream kinds

- Path stream: one file path per line
- Dataset stream: RDF statements carried between commands as N-Quads
- Bindings stream: SPARQL `SELECT` results as JSON Lines
- Text stream: human-oriented or general shell output

## Command roles

- Sources:
  - `rdf read`
  - `rdf from-paths`
- Dataset transforms:
  - `rdf construct`
  - `rdf claim`
  - `rdf validate`
  - `rdf graph-assign`
  - `rdf graph-drop`
  - `rdf skolem`
- Dataset to bindings:
  - `rdf select`
- Sinks:
  - `rdf pretty`
  - `rdf table`

## Claimers: the pipe is the cascade

A claimer is one claim (SHACL shapes: "these are the quads I read") plus a
fan-out of named views (CONSTRUCTs over the claimed quads only). One document
defines one claimer, and `rdf claim` applies one claimer per process — so a
cascade of claimers is just a pipe, and precedence is pipe order. There is no
order metadata anywhere.

What makes this sound is that claimed-vs-rest is marked by the graph term
itself, reusing the graph policy above:

- the working set is the **graphless** subset of the incoming stream;
- claiming moves **owned** quads (the ones a constraint read) out of graphless
  space — they land in the claimer's `:source` graph (provenance), and each
  view's output lands in the view's own graph;
- a claim also **borrows** a frontier: the quads its target navigation read
  (e.g. `rdf:type` for `sh:targetClass`). The frontier feeds the views but
  stays graphless in the rest — shared navigation vocabulary never starves
  later claimers targeting the same class. Copies land in the `:frontier`
  graph, so `:source` ∪ `:frontier` is exactly what the views were fed. A
  shape that wants to *own* its target quads says so with an explicit
  constraint (e.g. `[ sh:path rdf:type ]`);
- the rest stays graphless, still claimable by the next claimer;
- quads that already carry a named graph were claimed upstream and pass
  through untouched.

So "a later claimer cannot take an earlier claimer's quads" is not a runtime
check — it is impossible by construction, and any intermediate wire can be
inspected to see exactly what is claimed and by whom. Making named data
claimable is explicit, like every other graph-policy change: pipe
`rdf graph-drop` first.

```bash
rdf read ./data/**/*.ttl \
  | rdf claim ./claimers/person.trig \
  | rdf claim ./claimers/organization.trig \
  | rdf pretty --format trig
```

### Two ways to put CONSTRUCTs together

The cascade above and a view's own queries are different operations, and the
difference is which one *sees* the other's output:

| | reads | order | use it for |
|---|---|---|---|
| cascade of claimers | the graphless rest left by the previous claimer | pipe order decides **ownership** precedence | several claimers competing for one wire |
| fan-out across views | the same claimed feed, always | none — views commute | independent aspects of one claim |
| chain within a view | only the previous step's output | significant | deriving something, then using it |

A view declares a chain with `cascade:queries`, an RDF list — order matters, and
a list is the only ordered structure RDF offers:

```turtle
<urn:example:view/diagram> cascade:queries (
  "CONSTRUCT { ?s ?p ?o . ?t ex:short ?curie } WHERE { ... }"
  "CONSTRUCT { ... } WHERE { ... ?t ex:short ?curie ... }"
) .
```

Step n+1 sees **only** step n's output, so a step that wants to keep its input
re-emits it — that is why the first query above constructs `?s ?p ?o` as well
as the fact it derives.

Reach for the chain when a rule would otherwise be repeated at every site that
needs it. Reach for the cascade only when ownership actually changes hands: a
second claimer re-runs the claim, which is wasted work if the same quads are
simply being read again.

## Examples

Read files directly:

```bash
rdf read ./data/**/*.ttl | rdf pretty
```

Read RDF bytes from stdin:

```bash
cat ./data.ttl | rdf read | rdf pretty
```

Bridge a path-producing shell pipeline:

```bash
find ./data -name '*.ttl' | rdf from-paths --graph-from path | rdf pretty --format trig
```

Exit RDF space with `SELECT`:

```bash
rdf read ./data/**/*.ttl \
  | rdf select 'SELECT ?s ?p ?o WHERE { ?s ?p ?o }' \
  | rdf table --format csv
```

Make graph dropping explicit:

```bash
rdf read --graph-from path ./data/**/*.ttl \
  | rdf graph-drop \
  | rdf pretty --format turtle
```
