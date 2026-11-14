## MSW v2 HTTP Mocking (API Boundary Testing)

Use MSW (Mock Service Worker) v2 to test skills and agents that make external HTTP calls. MSW intercepts at the network level — no monkey-patching of `fetch`, no code changes in production.

```bash
pnpm add -D msw@2
```

### Setup Pattern (Node.js / Vitest)

```js
import { setupServer } from 'msw/node';
import { http, HttpResponse } from 'msw';

// Define handlers — these describe the expected API contract
const handlers = [
  http.get('https://api.example.com/search', ({ request }) => {
    const url = new URL(request.url);
    return HttpResponse.json({
      results: [{ id: 1, title: `Result for: ${url.searchParams.get('q')}` }],
    });
  }),
];

const server = setupServer(...handlers);
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

// Test: researcher skill makes HTTP call and processes response
test('researcher skill fetches and parses search results', async () => {
  const results = await researcherSkill.search('TDD patterns 2026');
  expect(results).toHaveLength(1);
  expect(results[0].title).toContain('TDD patterns');
});
```

### Override Per-Test for Error Cases

```js
test('researcher skill handles 503 gracefully', async () => {
  server.use(
    http.get('https://api.example.com/search', () => HttpResponse.json({}, { status: 503 }))
  );
  const results = await researcherSkill.search('TDD patterns');
  expect(results).toEqual([]); // Graceful empty fallback
});
```

**Key benefits over manual mocking:**

- Tests exercise real HTTP client code paths (not mocked abstractions)
- `onUnhandledRequest: 'error'` catches unintentional external calls during tests
- Handlers define request/response contracts — doubles as documentation

**Agent-Studio targets for MSW boundary tests:**

- `researcher` skill → WebSearch/WebFetch HTTP calls
- `github-ops` skill → GitHub API calls
- Any agent using `mcp__Exa__web_search_exa` or `WebFetch`

## Mutation Testing (Stryker JS)
