# Specs — mapping to traditional documentation categories

Thinkrail specs unify what's usually split across three traditional documentation silos into a single, graph-linked system.

## Mapping

| Traditional category | Thinkrail spec type |
|---|---|
| Business requirements | `goal-and-requirements` — product goals, scope; the graph's root |
| Systems reference | `architecture-design` — system-wide topology, cross-cutting decisions, invariants |
| Technical design | `module-design` / `submodule-design` — a package or directory's responsibility, boundary, and dependency edges |
| _(none)_ | `task-spec` — temporary working doc for an active piece of work; removed once the work ships |

## Key differences from traditional docs

| Traditional docs | Thinkrail specs |
|---|---|
| Separate documents for requirements, architecture, design | One graph with `parent`, `depends-on`, `references`, `implements` links |
| Often passive — reference material | Actively authoritative — code must conform to them |
| Can drift from reality over time | Must be updated *with* any code change that alters a boundary or decision |
| Rationale lives in PR descriptions, comments, meeting notes | Rationale lives *in the spec itself* — it's the only home for decisions, trade-offs, and post-mortems |

## The "on-rails" principle

A spec is high-signal enough that a future agent (or human) lands on the decisions without re-deriving them. Process skills name *what* to draft and *when*; the spec-graph skill owns the graph mechanics (frontmatter, link kinds, `spec_*` tools).
