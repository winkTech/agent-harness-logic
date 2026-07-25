# Harness JSON Schemas

`engine/schemas/` contains the Harness JSON Schema inventory.

- Active schema files: **22**
- Machine-readable inventory: `catalog.json`
- Catalog validator: `engine/scripts/lib/schema-catalog.cjs`
- Regression entry: `node engine/scripts/test-hooks/run-all-tests.cjs --no-persist`

## Contract

Every active schema must:

1. use the `*.schema.json` suffix;
2. be valid UTF-8 JSON;
3. declare a non-empty `$schema` dialect;
4. have exactly one matching entry in `catalog.json`;
5. keep the catalog `title` and optional `$id` synchronized with the schema file.

The `SchemaCatalog` regression test fails when a schema is missing, stale,
duplicated, malformed, or inconsistent with the catalog. This validation checks
the schema inventory and metadata; it does not claim that every schema has a
runtime consumer.

## Adding or changing a schema

1. Add or edit the `*.schema.json` file.
2. Update `catalog.json` in the same change.
3. Run the regression entry above.

Runtime consumers should validate their own data at their trust boundary and
must not treat presence in this catalog as proof of runtime wiring.
