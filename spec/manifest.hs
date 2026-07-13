{-# LANGUAGE DataKinds              #-}
{-# LANGUAGE DuplicateRecordFields  #-}
{-# LANGUAGE GADTs                  #-}
{-# LANGUAGE KindSignatures         #-}
{-# LANGUAGE RankNTypes             #-}
{-# LANGUAGE TypeFamilies           #-}

-- | Type-level manifest of rdf-cli.
--
-- This is a /signature-level/ spec, not compiled code. It mirrors @src/@ so the
-- whole system can be reviewed through Haskell's types. It is the executable-looking
-- companion to @spec/rdf-cli semantics.md@ and @spec/stream-algebra.md@.
--
-- Conventions used to map the JavaScript onto types:
--
--   * @IO a@            — touches the filesystem, stdin, or stdout.
--   * @Either Error a@  — the JS implementation @throw@s on this path.
--   * @Maybe a@         — the JS returns @null@ / @undefined@ on this path.
--   * @IO a@ that "never returns" — the JS calls @process.exit@ (noted inline).
--   * @Stream a@        — an async, single-pass sequence (a Node @Readable@ in object
--                         mode, or an async generator). Produced lazily, consumed once.
--
-- Graph policy, in one line: a 'Quad' always carries a graph term; 'DefaultGraph'
-- means "graphless", and nothing turns graphless into named implicitly.

module RdfCli.Manifest where

import Control.Arrow (Kleisli)
import Control.Category (Category)
import Control.Monad.Trans.State (StateT)
import Data.Kind (Type)

--------------------------------------------------------------------------------
-- RDF core (the RDF/JS data model, as provided by rdf-ext)
--------------------------------------------------------------------------------

type Iri      = String
type Lexical  = String
type LangTag  = String
type Datatype = Iri

data Term
  = NamedNode    Iri
  | BlankNode    String
  | Literal      Lexical (Maybe LangTag) Datatype
  | DefaultGraph                            -- ^ the "no graph" graph term

-- | Positional roles are not enforced at the type level here, but the intent is:
-- subject ∈ {NamedNode, BlankNode}, predicate ∈ {NamedNode},
-- object ∈ {NamedNode, BlankNode, Literal}, graph ∈ {NamedNode, BlankNode, DefaultGraph}.
-- RDF/JS represents all positions with the same 'Term' shape; this manifest keeps
-- that shape rather than introducing separate graph/subject/object term wrappers.
-- Language-tagged literals follow RDF/JS: their datatype is rdf:langString; literals
-- without a language tag carry their explicit datatype.
data Quad = Quad
  { subject   :: Term
  , predicate :: Term
  , object    :: Term
  , graph     :: Term
  }

data Dataset     -- ^ @rdf.dataset()@: an in-memory, de-duplicated set of quads.
data Store       -- ^ oxigraph in-memory triplestore (opaque; the SPARQL engine).

type Error = String
-- Error policy: this manifest mirrors the current JS surfaces instead of
-- normalizing them away. 'Either Error a' marks explicit throw-like paths,
-- callback fields mark recoverable per-item errors, and noted @process.exit@
-- paths are terminal CLI effects. A future JS cleanup may collapse these into
-- one ExceptT-style layer; the current contract stays precise about reality.

--------------------------------------------------------------------------------
-- Stream carriers (what actually flows over a Unix pipe)
--------------------------------------------------------------------------------

data Stream a    -- ^ async, single-pass sequence.

type QuadStream     = Stream Quad       -- ^ the "dataset stream"; wire encoding = N-Quads.
type BindingsStream = Stream Row        -- ^ SPARQL SELECT results.
type PathStream     = Stream FilePath   -- ^ one path per line.
type Row            = [(Var, Term)]     -- ^ one SELECT solution.
type Var            = String
type Line           = String
type Byte           = Int

-- | Logical stream shapes, borrowed as vocabulary from stream types. These are
-- not the CLI wire kinds below: they describe richer structure inside one
-- dataset-producing operation.
data StreamShape a
  = One a
  | Empty
  | Seq (StreamShape a) (StreamShape a)  -- ^ @s · t@: first @s@, then @t@.
  | Par (StreamShape a) (StreamShape a)  -- ^ @s ‖ t@: independent logical channels.
  | Many (StreamShape a)                 -- ^ @s*@.

-- | The closed set of stream kinds the CLI tags each command with (the @io@
-- metadata in every command module, surfaced by @scripts/manifest.js@).
data StreamKind
  = RDF                 -- ^ serialized RDF /bytes/, any supported media type (read's stdin).
  | NQuads              -- ^ the normalized dataset stream on the wire.
  | JSONLinesBindings   -- ^ select's output: one JSON object per line.
  | Text                -- ^ a sink's human/text output.
  | PathLines           -- ^ one file path per line (from-paths' stdin).

--------------------------------------------------------------------------------
-- Formats  (src/formats.js)
--------------------------------------------------------------------------------

type MimeType = String
type Token    = String   -- ^ a user-facing format token, e.g. "ttl", "nq", "trig".
type Sample   = String   -- ^ leading bytes of an input, decoded as text.

nquads, ntriples, turtle, trig :: MimeType

-- | Token (case-insensitive) → MIME type; unknown tokens pass through unchanged.
resolveFormat :: Maybe Token -> Maybe MimeType
-- | By file extension.
guessMimeType :: FilePath -> Maybe MimeType
-- | Content sniffing over the first ~500 bytes (Turtle/JSON-LD/RDF-XML/TriG/N-Quads/N-Triples).
detectFormat  :: Sample -> Maybe MimeType

--------------------------------------------------------------------------------
-- Sources  (src/sources)
--------------------------------------------------------------------------------

data GraphFrom = Path       -- ^ the only accepted @--graph-from@ value.

data ReadOpts = ReadOpts
  { graphFrom :: Maybe GraphFrom                 -- ^ Just Path ⇒ default graph := file:// IRI.
  , onError   :: Maybe (FilePath -> Error -> IO ())
  }

type Pattern = String

-- | Parse one file into quads. @throw@s when the format cannot be resolved.
streamFileQuads :: FilePath -> Maybe MimeType -> Either Error QuadStream

-- | Parse each path independently; per-file failures go to 'onError', the rest continue.
readFromPaths :: PathStream -> ReadOpts -> QuadStream
-- | Expand globs, then 'readFromPaths'.
readFromGlob  :: [Pattern] -> ReadOpts -> QuadStream

-- | Read RDF bytes from stdin. With a hint, stream directly; without, buffer and
-- 'detectFormat'. Calls @process.exit 1@ when the format cannot be detected.
readFromStdin :: Maybe MimeType -> IO QuadStream

--------------------------------------------------------------------------------
-- Transforms  (src/transforms) — dataset → dataset unless noted
--------------------------------------------------------------------------------

type Pipe a b = Stream a -> Stream b
type QuadPipe = Pipe Quad Quad
type Query = String

-- | Evidence that every graph term inside @a@ is 'DefaultGraph'. Two
-- introduction forms only: 'dropGraph' (force graphlessness — an explicit
-- policy change) and 'splitClaimable' (select the already-graphless subset
-- of a wire). Constructor private by convention. The CLI graph-drop command
-- forgets the evidence at the process boundary ('fromGraphless'): the
-- N-Quads wire carries no types.
newtype Graphless a = Graphless a

-- Law (split idempotent): dropGraph ∘ fromGraphless = id on 'Graphless', and
-- dropGraph is idempotent on the wire — dropping twice is dropping once.
fromGraphless :: Graphless a -> a

assignGraph :: Iri -> QuadPipe      -- ^ graphless → the named graph; existing graphs kept.
dropGraph   :: QuadStream -> Graphless QuadStream -- ^ every graph term → DefaultGraph.
skolemize   :: Iri -> QuadPipe      -- ^ blank nodes → generated IRIs, consistent within one run.

-- SPARQL: materialization is its own step, so one Store feeds many query ops
-- instead of each op re-draining the source. Store-level ops are pure over the
-- store (oxigraph queries run synchronously).
materialize :: QuadStream -> IO Store           -- ^ drains the stream into a store.
select      :: Store -> Query -> BindingsStream -- ^ leaves RDF space.
construct   :: Store -> Query -> QuadStream      -- ^ output graphless (engine can't emit graphs).

-- Claimers  (src/transforms/claimer.js, src/transforms/claim.js)
--
-- A claimer is ONE claim (SHACL shapes) plus a fan-out of named views
-- (CONSTRUCTs). One document defines one claimer — 'loadClaimer' rejects
-- more — and each process applies one claimer, so the cascade IS the Unix
-- pipe and precedence is pipe order. No order metadata exists.
--
-- Claimed/rest is marked by graph terms, reusing the graph policy above: the
-- working set is the GRAPHLESS subset of the incoming stream; quads that
-- already carry a named graph were claimed upstream and pass through
-- untouched; claiming moves OWNED quads out of graphless space (source graph,
-- view graphs); the rest stays graphless for the next claimer. Hence a
-- theorem, not a runtime check: a later claimer can never take an earlier
-- claimer's quads. Half of that is the ArrowChoice fusion law — viewing the
-- wire as Stream (Either graphless named) ('splitClaimable'), 'applyClaimer'
-- acts as @left f@, and @left f >>> left g = left (f >>> g)@: composed
-- claimers only ever touch the graphless summand. The other half is
-- 'runClaimer' itself: owned quads come out NAMED (moved to the right
-- summand), so composition is monotone. 'dropGraph' is the explicit
-- injection back into the left summand. A claim also BORROWS a frontier — the quads its target
-- navigation read (e.g. rdf:type) — which feeds the views but stays graphless
-- in the rest, so shared navigation vocabulary never starves later claimers.
--
-- Views do not fold: every view reads the SAME claimed set, independently —
-- order-insensitive, parallelizable, each naming its own output graph. The
-- claim boundary is explicit: 'projectView' seeds each view from
-- 'ClaimedSet c', never from the whole working set. ('chainConstructs' below
-- is the different, sequential operation.)
--
-- How to read the phantom @c@: it names one claim rule at the type level, so
-- quads claimed by that rule cannot be confused with another rule's quads in
-- the signatures below. The set of claim rules is open — claimer documents
-- introduce them at runtime — so loaded claimers are packed with 'Some'.
data ClaimId
data WorkingSet                   -- ^ the graphless subset of the wire; claimable.

-- | The claimable working set is the graphless subset of the wire:
-- 'splitClaimable' selects it, named quads carry on as pass-through. 'claim'
-- relies on graphlessness — coverage comes back as bare (s, p, o) triples,
-- and comparing those against the working set is only sound when the working
-- set is graphless too. Making named data claimable is explicit: pipe
-- @rdf graph-drop@ first.
splitClaimable :: QuadStream -> (Graphless QuadStream, QuadStream)
mkWorkingSet   :: Graphless QuadStream -> IO WorkingSet
data Claims       (c :: ClaimId)  -- ^ claim rules for one claimer (currently SHACL shapes).
data ClaimedSet   (c :: ClaimId)  -- ^ owned by 'Claims c': quads a constraint read.
data FrontierSet  (c :: ClaimId)  -- ^ borrowed by 'Claims c': quads target navigation read.
data ProjectedSet                 -- ^ derived quads emitted from a view feed.

-- | The decomposition one claim performs. Owned quads leave graphless space;
-- borrowed quads are read (target navigation, view feeds) but stay in the
-- remainder — taking navigation quads would starve later claimers of shared
-- vocabulary like rdf:type.
data ClaimSplit c = ClaimSplit
  { claimed   :: ClaimedSet c
  , frontier  :: FrontierSet c
  , remainder :: WorkingSet
  }

claim :: Claims c -> WorkingSet -> IO (ClaimSplit c)
-- Laws for @ClaimSplit claimed frontier remainder <- claim claims input@:
--   (viewed as sets of quads)
--   partition: claimed ∪ remainder = input
--   disjoint:  claimed ∩ remainder = ∅
--   borrowed:  frontier ⊆ remainder, frontier ∩ claimed = ∅
-- The partition laws lean on 'WorkingSet' being graphless (see 'mkWorkingSet').
-- Ownership of navigation quads is opt-in: a shape that wants to TAKE its
-- target quads reads them with an explicit constraint (e.g. [ sh:path rdf:type ]).

data Construct = ConstructQuery Query

-- | One derivation: run the CONSTRUCT over the claimed quads only, so its
-- WHERE cannot overreach the claim.
runConstruct :: Construct -> Dataset -> IO Dataset

-- | What a view may read: the owned quads plus the borrowed frontier. The
-- claim boundary stays explicit — never the whole working set.
data ViewFeed (c :: ClaimId)

viewFeed      :: ClaimedSet c -> FrontierSet c -> ViewFeed c
feedToDataset :: ViewFeed c -> Dataset
asProjected   :: Dataset -> ProjectedSet

-- | One named aspect of a claimer: a CONSTRUCT and the graph its output
-- lands in. Naming the output is what lets several views coexist.
data View = View
  { viewGraph :: Iri
  , viewQuery :: Construct
  }

-- Law (fan-out): 'runViews' is 'traverse' over the views, and its effects
-- COMMUTE — every view reads the same feed, none reads another's output.
-- Commutativity is the one word that licenses parallelism and loadClaimer's
-- free sorting. (JS: a loop that could be Promise.all.)
-- projectView v feed = asProjected <$> runConstruct (viewQuery v) (feedToDataset feed)
-- runViews vs feed   = traverse (\v -> (viewGraph v ,) <$> projectView v feed) vs
projectView :: View -> ViewFeed c -> IO ProjectedSet
runViews    :: [View] -> ViewFeed c -> IO [(Iri, ProjectedSet)]

-- | Sequential CONSTRUCT pipeline — a DIFFERENT operation from a claimer's
-- view fan-out, and the dichotomy has standard names: the fan-out is
-- 'traverse' in a commuting applicative ('runViews' below); the chain is the
-- Kleisli-composition monoid — order significant, step n+1 sees only step
-- n's output. Declared so the algebra names the use case; deliberately
-- unimplemented in the library — the CLI already covers it by piping
-- @rdf construct@ ('Construct' via ':>').
-- chainConstructs = foldr (\c k -> runConstruct c >=> k) pure
chainConstructs :: [Construct] -> Dataset -> IO Dataset

data Claimer (c :: ClaimId) = Claimer
  { claimerGraph  :: Iri     -- ^ the claimer's name; claimed quads land in 'sourceGraphOf' it.
  , claimerClaims :: Claims c
  , claimerViews  :: [View]  -- ^ [] => claim-only.
  }

sourceGraphOf   :: Iri -> Iri
frontierGraphOf :: Iri -> Iri

data ClaimerStep c = ClaimerStep
  { stepClaimer  :: Claimer c
  , stepSource   :: ClaimedSet c
  , stepFrontier :: FrontierSet c
  , stepViews    :: [(Iri, ProjectedSet)]
    -- ^ aligned 1:1 with 'claimerViews'; an empty 'ProjectedSet' means "this
    -- view matched nothing", still distinguishable per view.
  }

-- runClaimer cl ws = claim (claimerClaims cl) ws, then fan the views out over
-- 'viewFeed' claimed frontier; the remainder is the graphless rest for the wire.
runClaimer :: Claimer c -> WorkingSet -> IO (ClaimerStep c, WorkingSet)

data Some (f :: ClaimId -> Type) where
  Some :: f c -> Some f

type SomeClaimer = Some Claimer

-- The wire around one claimer: upstream claims pass through untouched, then
-- the claimer's own channels. The frontier channel carries COPIES in the
-- :frontier graph — provenance of what the views were fed beyond the source
-- (source ∪ frontier = exactly the view inputs). The borrowed originals stay
-- graphless in the rest, so frontier is the one channel whose quads appear
-- twice on the wire.
data WireChannel
  = PassThroughChannel | SourceChannel | FrontierChannel | ViewChannel | RestChannel

-- claimerShape =
--   PassThroughChannel ‖ SourceChannel ‖ FrontierChannel ‖ Many ViewChannel ‖ RestChannel
claimerShape :: StreamShape WireChannel

data ClaimerResult = ClaimerResult
  { resultStep        :: Some ClaimerStep
  , resultRest        :: WorkingSet   -- ^ stays graphless on the wire.
  , resultPassThrough :: QuadStream   -- ^ upstream claims, untouched.
  }

-- | One document, one claimer; anything else is an error.
loadClaimer :: Dataset -> Either Error SomeClaimer

-- applyClaimer cl wire = 'splitClaimable' the wire, 'mkWorkingSet' the
-- graphless side, 'runClaimer' over it, carry the named side as pass-through.
applyClaimer :: SomeClaimer -> QuadStream -> IO ClaimerResult

-- Serializes the channels: pass-through unchanged, claimed → source graph,
-- frontier copies → frontier graph, each view → its own graph, rest stays
-- graphless. The CLI verb is 'Claim' in the Cmd algebra below.
emitClaimer :: ClaimerResult -> QuadStream

-- SHACL validation.
data BuiltinName = Shacl | Skos
type ShapeSource = Pattern

resolveBuiltinShapes :: BuiltinName -> Maybe FilePath

data ValidationStats = ValidationStats
  { validationQuadsIn  :: Int
  , validationQuadsOut :: Int
  }

-- | Consumes the same 'Store' (the shacl dataset is derived from it), so validation
-- composes with the SPARQL ops over a single materialization. Returns the original
-- data ++ the report in a named graph, the 'Summary' verdict, and validation counts
-- for provenance.
validate :: Store -> [ShapeSource] -> Iri {- reportGraph -} -> IO (QuadStream, Summary, ValidationStats)

data ShapeViolation = ShapeViolation
  { focusNode        :: String
  , path             :: String
  , severity         :: Severity
  , sourceConstraint :: String
  , message          :: String
  , value            :: String
  }

data Severity = Info | Warning | Violation

data Summary = Summary
  { conforms       :: Bool
  , violationCount :: Int
  , violations     :: [ShapeViolation]
  }

type Text = String

formatMarkdownReport :: Summary -> String {- label -} -> Text

--------------------------------------------------------------------------------
-- Sinks  (src/sinks) — terminal effects: bytes/text to stdout
--------------------------------------------------------------------------------

data TableFormat = CSV | TSV | JSONL

toReadable      :: Stream a -> Stream a          -- ^ idempotent coercion to a Readable.
writeQuads      :: QuadStream -> MimeType -> IO ()          -- ^ default MimeType = nquads.

loadPrefixes    :: Maybe FilePath -> IO Prefixes           -- ^ discovers .prefixes.json / prefixes.json.
triplify        :: Dataset -> Prefixes -> IO Text -- ^ pretty TriG, falling back to Turtle when graphless.
datasetToString :: Dataset -> MimeType -> Prefixes -> IO Text
-- | Default format = trig. nquads/ntriples delegate to 'writeQuads' (ntriples drops graphs).
writePretty     :: QuadStream -> MimeType -> Prefixes -> IO ()

bindingToJSONL  :: Row -> Text
writeBindings   :: BindingsStream -> IO ()

writeTable      :: Stream Line -> TableFormat -> IO ()

type Prefixes = [(Prefix, Iri)]
type Prefix   = String

--------------------------------------------------------------------------------
-- Utils  (src/utils.js)
--------------------------------------------------------------------------------

collectDataset :: QuadStream -> IO Dataset
readLines      :: Stream Byte -> Stream Line     -- ^ trimmed, non-empty lines.

--------------------------------------------------------------------------------
-- The CLI as a typed stream algebra  (spec/stream-algebra.md, made checkable)
--
-- Each verb is indexed by the stream kind it consumes and the kind it produces.
-- Composition typechecks only when adjacent wire kinds agree — that is the whole
-- point of the "N-Quads between transforms" rule.
--------------------------------------------------------------------------------

data Cmd (i :: StreamKind) (o :: StreamKind) where
  Read        :: Cmd 'RDF        'NQuads              -- ^ or file args → NQuads (bytes-in variant).
  FromPaths   :: Cmd 'PathLines  'NQuads
  Select      :: Query -> Cmd 'NQuads 'JSONLinesBindings
  Construct   :: Query -> Cmd 'NQuads 'NQuads
  Claim       :: FilePath -> Cmd 'NQuads 'NQuads      -- ^ one claimer per process; pipe several to cascade.
  Validate    :: Cmd 'NQuads 'NQuads                  -- ^ exit code 1 on non-conformance.
  GraphAssign :: Iri -> Cmd 'NQuads 'NQuads
  GraphDrop   :: Cmd 'NQuads 'NQuads
  Skolem      :: Cmd 'NQuads 'NQuads
  Pretty      :: Cmd 'NQuads 'RDF                     -- ^ emits re-readable serialized RDF.
  Table       :: Cmd 'JSONLinesBindings 'Text

-- Law (Pretty/Read): a section–retraction pair UP TO blank-node relabeling —
-- read ∘ pretty yields an isomorphic dataset, not an equal one (parsers mint
-- fresh bnode labels; equality holds for skolemized data). The converse never
-- holds: pretty ∘ read normalizes formatting.

-- | Denotation of wire kinds: what carries each kind in-process. (The object
-- mapping of the 'foldPipeline' functor.)
type family Carrier (k :: StreamKind) :: Type where
  Carrier 'RDF               = Stream Byte
  Carrier 'NQuads            = QuadStream
  Carrier 'JSONLinesBindings = BindingsStream
  Carrier 'PathLines         = PathStream
  Carrier 'Text              = Stream Line

-- | A pipeline is a path of commands whose wire kinds line up end to end —
-- the free category over the 'Cmd' quiver. Associativity and identity of
-- '(>>>)' hold by the free construction; no law comments needed.
data Pipeline (i :: StreamKind) (o :: StreamKind) where
  Done :: Pipeline i i                              -- ^ identity.
  (:>) :: Cmd i m -> Pipeline m o -> Pipeline i o
infixr 5 :>

-- | Append whole pipelines: reusable fragments (a standard ingest prefix, a
-- standard validation suffix) compose instead of being re-spelled.
(>>>) :: Pipeline i m -> Pipeline m o -> Pipeline i o

-- | The interpreter is the free category's universal property: give each
-- 'Cmd' a meaning in ANY target category k and the pipeline's meaning
-- follows. k = Kleisli IO runs it; k = Kleisli OpM (the 'Op' arrow below)
-- records provenance while running — making "the Cmd algebra is the CLI
-- projection of the library layer" a functor rather than a comment.
foldPipeline
  :: Category k
  => (forall a b. Cmd a b -> k (Carrier a) (Carrier b))
  -> Pipeline i o -> k (Carrier i) (Carrier o)

-- Well-typed:   Read :> Select q :> Table :> Done    :: Pipeline 'RDF 'Text
-- Ill-typed:    Read :> Table :> Done   -- NQuads ≠ JSONLinesBindings, rejected.

--------------------------------------------------------------------------------
-- Operations & provenance  (proposed — the composable, lineage-tracking layer)
--
-- The 'Cmd' algebra above is the user-facing CLI projection (one verb per
-- process). The library composes in a single process, and every component
-- collapses to ONE arrow: 'Op', a Kleisli arrow over State-in-IO — the
-- lineage is readable (any op inspects prior results) and appendable (each
-- op records one result). Provenance is a library concern only; it never
-- crosses a Unix pipe, so nothing here is serialized between processes.
--
-- JS traceability (src/pipeline/core.js): JS cannot carry these types, so it
-- carries them at runtime as a tagged value sum ('quads' | 'store' | ...).
-- Each expectValue call in the JS is the runtime projection of an 'Op' type
-- annotation here, and core.js's pipe is '(>>>)' on 'Op'. A composition this
-- spec rejects as a type error is exactly one the JS rejects at runtime with
-- a TypeError — the same property 'Cmd' has on the wire, inside the library.
--------------------------------------------------------------------------------

type OpId    = String
type Lineage = [OpResult]

-- | Lineage readable (get) and appendable (modify): State over a growing
-- lineage, in IO.
type OpM = StateT Lineage IO

-- | THE one component shape. Sources, transforms, sinks, and guards are all
-- 'Op'; composing a Store-consumer after a Text-producer is unwritable.
type Op a b = Kleisli OpM a b

-- | One record appended per operation. 'inputs' records lineage by id, so even a
-- linear run captures DAG-shaped provenance that can be reconstructed as a graph.
data OpResult = OpResult
  { opId   :: OpId
  , kind   :: OpKind
  , inputs :: [OpId]       -- ^ the prior results this op consumed.
  , meta   :: Meta
  }

data OpKind
  = ReadOp
  | MaterializeOp
  | SelectOp
  | ConstructOp
  | ValidateOp
  | GraphAssignOp
  | GraphDropOp
  | SkolemOp
  | RequireConformanceOp

-- | Measured facts kept in lineage. Data-dependent fields are only filled by ops that
-- actually materialize ('materialize', 'validate'); streaming ops leave them Nothing —
-- the stream is still unconsumed when the envelope is passed on.
data Meta = Meta
  { startedAt  :: Timestamp
  , durationMs :: Int
  , quadsIn    :: Maybe Int
  , quadsOut   :: Maybe Int
  , droppedIn  :: Maybe Int     -- ^ quads oxigraph refused (the materialize warning).
  , validation :: Maybe Summary -- ^ validate only: the SHACL verdict, readable downstream.
  , passed     :: Maybe Bool    -- ^ requireConformance only.
  }
type Timestamp = String

-- | The one lifting combinator: run the core function over the input, append
-- one 'OpResult' (fresh id, kind, lineage, measured 'Meta'). The core
-- functions above are unchanged; the lift only adds provenance.
record :: OpKind -> (a -> IO (b, Meta)) -> Op a b

-- Representative typed ops, each 'record' over its core function. Their JS
-- twins live in src/pipeline/operations.js with the matching expectValue tag.
readOp        :: [Pattern] -> Op () QuadStream
materializeOp :: Op QuadStream Store
selectOp      :: Query -> Op Store BindingsStream
constructOp   :: Query -> Op Store QuadStream

-- | 'validate' lifts so its 'Summary' lands in the appended result's
-- 'meta.validation'. There is no bespoke return value — the verdict travels
-- as lineage.
validateOp :: [ShapeSource] -> Iri -> Op Store QuadStream

-- | A guard is an ordinary 'Op' that reads the lineage and may abort: it
-- scans for the latest 'validateOp' result and stops the pipeline when it
-- did not conform — the "check validity, otherwise abort" use case.
requireConformance :: Op a a
data Abort = Abort OpId String   -- ^ thrown in IO: which op aborted, and why.

-- | Render lineage to PROV-O RDF on demand (opt-in):
--   OpResult -> prov:Activity  (prov:startedAtTime, durationMs/counts as typed literals)
--   inputs   -> prov:used / prov:wasDerivedFrom
-- A monoid homomorphism (Lineage, ++) → (Dataset, ∪): rendering history
-- incrementally as you go equals rendering it all at the end.
provenanceToDataset :: Lineage -> Dataset

--------------------------------------------------------------------------------
-- Public library surface  (src/index.js)
--
--   import { sources, transforms, sinks, pipeline } from 'rdf-cli'
--
-- Only these four namespaces are exported; command modules stay internal.
-- 'pipeline' is the 'Op' layer above; the others are its building blocks.
--------------------------------------------------------------------------------

--------------------------------------------------------------------------------
-- Compile-only stubs
--
-- The manifest is signature-level, but keeping it as a valid Haskell module lets
-- lint catch drift. These bindings are deliberately collected here so the algebra
-- above reads as declarations, not implementation.
--------------------------------------------------------------------------------

manifestOnly :: a
manifestOnly = error "signature-level manifest only"

nquads = manifestOnly
ntriples = manifestOnly
turtle = manifestOnly
trig = manifestOnly

resolveFormat = manifestOnly
guessMimeType = manifestOnly
detectFormat = manifestOnly

streamFileQuads = manifestOnly
readFromPaths = manifestOnly
readFromGlob = manifestOnly
readFromStdin = manifestOnly

fromGraphless = manifestOnly
assignGraph = manifestOnly
dropGraph = manifestOnly
skolemize = manifestOnly
materialize = manifestOnly
select = manifestOnly
construct = manifestOnly

splitClaimable = manifestOnly
mkWorkingSet = manifestOnly
claim = manifestOnly
runConstruct = manifestOnly
chainConstructs = manifestOnly
viewFeed = manifestOnly
feedToDataset = manifestOnly
asProjected = manifestOnly
projectView = manifestOnly
runViews = manifestOnly
sourceGraphOf = manifestOnly
frontierGraphOf = manifestOnly
runClaimer = manifestOnly
claimerShape = manifestOnly
loadClaimer = manifestOnly
applyClaimer = manifestOnly
emitClaimer = manifestOnly

resolveBuiltinShapes = manifestOnly
validate = manifestOnly
formatMarkdownReport = manifestOnly

toReadable = manifestOnly
writeQuads = manifestOnly
loadPrefixes = manifestOnly
triplify = manifestOnly
datasetToString = manifestOnly
writePretty = manifestOnly
bindingToJSONL = manifestOnly
writeBindings = manifestOnly
writeTable = manifestOnly

collectDataset = manifestOnly
readLines = manifestOnly

(>>>) = manifestOnly
foldPipeline _ _ = manifestOnly   -- eta-expanded: the rank-2 argument must be bound.
record = manifestOnly
readOp = manifestOnly
materializeOp = manifestOnly
selectOp = manifestOnly
constructOp = manifestOnly
validateOp = manifestOnly
requireConformance = manifestOnly
provenanceToDataset = manifestOnly
