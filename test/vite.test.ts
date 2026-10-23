import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { createServer as createHttpServer, get as httpGet, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import { build, createLogger, createServer, type Rollup, type ViteDevServer } from 'vite';
import bqueryVite from '../vite.js';
import { createProject, SAMPLE_FILES, waitFor, type TempProject } from './helpers';

const INDEX_HTML = `<!doctype html>
<html>
  <head><title>app</title><style>p { color: red; }</style></head>
  <body>
    <div id="app"></div>
    <script type="module" src="/src/main.js"></script>
  </body>
</html>`;

const ENTRY_SERVER = `import { createSSRContext, renderToResponse } from '@bquery/bquery/ssr';

export async function render(request, ctx) {
  const ssr = createSSRContext({ request, nonce: ctx.nonce });
  const { pathname } = ssr.url;
  if (pathname === '/fallthrough') return null;
  if (pathname === '/bquery') {
    const template = ctx.template.replace('<div id="app"></div>', '<div id="app"><h1 bq-text="title"></h1></div>');
    return renderToResponse(template, { title: 'Rendered by bQuery' }, { context: ssr });
  }
  if (pathname === '/boom') throw new Error('render exploded');
  if (pathname === '/proxied') {
    // fetch() decodes the gzip body but keeps the upstream's encoding headers.
    return fetch(ssr.url.searchParams.get('upstream'));
  }
  if (pathname === '/api-like') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { 'content-type': 'application/json', 'x-from': 'entry' },
    });
  }
  if (pathname === '/response') {
    return new Response(ctx.template.replace('<div id="app"></div>', '<div id="app">resp</div>'), {
      status: 404,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });
  }
  return ctx.template.replace(
    '<div id="app"></div>',
    '<div id="app">SSR ' + pathname + ' nonce=' + ssr.nonce + '</div>'
  );
}
`;

describe('vite build', () => {
  let project: TempProject;
  let output: Rollup.RollupOutput['output'];
  const warnings: string[] = [];

  beforeAll(async () => {
    project = createProject({ ...SAMPLE_FILES, 'index.html': INDEX_HTML });
    const result = (await build({
      root: project.root,
      configFile: false,
      logLevel: 'silent',
      plugins: [bqueryVite({ i18n: true, csp: true })],
      build: {
        write: false,
        rollupOptions: {
          external: [/^@bquery\//],
          onwarn: (warning) => warnings.push(warning.message),
        },
      },
    })) as Rollup.RollupOutput;
    output = result.output;
  });

  afterAll(() => project.cleanup());

  const js = () =>
    output
      .filter((file): file is Rollup.OutputChunk => file.type === 'chunk')
      .map((chunk) => chunk.code)
      .join('\n');

  it('bundles compiled views, the route manifest and the catalogs', () => {
    expect(js()).toContain('count + 1');
    expect(js()).toContain('registerCompiledExpressions');
    expect(js()).toContain('createFileRoutes');
    expect(js()).toContain('/src/routes/users/[id]/+page.ts');
    expect(js()).toContain('Home');
    expect(js()).not.toContain('import.meta.hot');
    expect(JSON.parse(project.read('locales/en.json')).nav.about).toBe('About');
  });

  it('splits lazy route modules into their own chunks', () => {
    const chunks = output.filter((file) => file.type === 'chunk' && !file.isEntry);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
  });

  it('warns about runtime-fallback expressions', () => {
    expect(warnings.some((w) => w.includes('falls back to the runtime evaluator'))).toBe(true);
  });

  it('leaves built HTML without nonces unless csp.build is set', async () => {
    const html = output.find((file) => file.fileName === 'index.html') as Rollup.OutputAsset;
    expect(String(html.source)).not.toContain('nonce=');

    const placeholder = (await build({
      root: project.root,
      configFile: false,
      logLevel: 'silent',
      plugins: [bqueryVite({ i18n: true, csp: { nonce: '__NONCE__', build: true } })],
      build: { write: false, rollupOptions: { external: [/^@bquery\//], onwarn: () => {} } },
    })) as Rollup.RollupOutput;
    const built = placeholder.output.find((file) => file.fileName === 'index.html');
    expect(String((built as Rollup.OutputAsset).source)).toContain('nonce="__NONCE__"');
  });
});

/** A Node response read without decoding: status, raw headers and body bytes. */
const rawGet = (url: string, accept = 'text/html') =>
  new Promise<{
    status: number;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  }>((resolve, reject) => {
    httpGet(url, { headers: { accept } }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        })
      );
      res.on('error', reject);
    }).on('error', reject);
  });

/** An upstream that always answers with a gzip-compressed body. */
const startGzipUpstream = async () => {
  const bodies: Record<string, { type: string; body: string }> = {
    '/data.json': { type: 'application/json', body: JSON.stringify({ hello: 'gzip'.repeat(64) }) },
    '/page.html': {
      type: 'text/html; charset=utf-8',
      body: `<!doctype html><html><head></head><body><p>${'upstream '.repeat(64)}</p></body></html>`,
    },
  };
  const upstream: Server = createHttpServer((req, res) => {
    const entry = bodies[req.url ?? ''];
    if (!entry) {
      res.statusCode = 404;
      res.end();
      return;
    }
    const gz = gzipSync(entry.body);
    res.writeHead(200, {
      'content-type': entry.type,
      'content-encoding': 'gzip',
      'content-length': String(gz.length),
      'x-upstream': 'yes',
      'set-cookie': ['a=1; Path=/', 'b=2; Path=/; HttpOnly'],
    });
    res.end(gz);
  });
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const { port } = upstream.address() as AddressInfo;
  return { upstream, url: `http://127.0.0.1:${port}`, bodies };
};

describe('vite build: view imports with a query', () => {
  let project: TempProject;
  let output: Rollup.RollupOutput['output'];

  beforeAll(async () => {
    project = createProject({
      'src/main.js': [
        "import template from './views/home.view.html';",
        "import raw from './views/raw.view.html?raw';",
        "import url from './views/url.view.html?url';",
        'console.log(template, raw, url);',
      ].join('\n'),
      'src/views/home.view.html': '<p bq-text="count + 1"></p>',
      'src/views/raw.view.html': '<aside bq-text="rawOnly + 1"></aside>',
      'src/views/url.view.html': '<nav bq-text="urlOnly + 1"></nav>',
    });
    const result = (await build({
      root: project.root,
      configFile: false,
      logLevel: 'silent',
      plugins: [bqueryVite()],
      build: {
        write: false,
        minify: false,
        assetsInlineLimit: 0,
        rollupOptions: { input: project.path('src/main.js'), external: [/^@bquery\//] },
      },
    })) as Rollup.RollupOutput;
    output = result.output;
  });

  afterAll(() => project.cleanup());

  const js = () =>
    output
      .filter((file): file is Rollup.OutputChunk => file.type === 'chunk')
      .map((chunk) => chunk.code)
      .join('\n');

  it('still compiles bare *.view.html imports', () => {
    expect(js()).toContain('registerCompiledExpressions');
    expect(js()).toContain('__bq_ctx.count + 1');
  });

  it('returns the raw markup for ?raw', () => {
    expect(js()).toMatch(/<aside bq-text=\\?"rawOnly \+ 1\\?"><\/aside>/);
    expect(js()).not.toContain('__bq_ctx.rawOnly');
  });

  it('returns an asset URL for ?url', () => {
    const asset = output.find(
      (file): file is Rollup.OutputAsset => file.type === 'asset' && file.fileName.endsWith('.html')
    );
    expect(asset).toBeDefined();
    expect(String(asset!.source)).toBe('<nav bq-text="urlOnly + 1"></nav>');
    expect(js()).toContain(`/${asset!.fileName}`);
    expect(js()).not.toContain('__bq_ctx.urlOnly');
  });
});

describe('vite dev server', () => {
  let project: TempProject;
  let server: ViteDevServer;
  let base: string;
  let gzip: Awaited<ReturnType<typeof startGzipUpstream>>;
  const errors: string[] = [];
  const routeUpdates: string[] = [];

  beforeAll(async () => {
    gzip = await startGzipUpstream();
    project = createProject({
      ...SAMPLE_FILES,
      'index.html': INDEX_HTML,
      'src/entry-server.js': ENTRY_SERVER,
    });
    // The SSR entry imports `@bquery/bquery/ssr` from the temp project.
    project.linkBquery();
    const logger = createLogger('error', { allowClearScreen: false });
    logger.error = (msg) => {
      errors.push(msg);
    };
    server = await createServer({
      root: project.root,
      configFile: false,
      customLogger: logger,
      optimizeDeps: { noDiscovery: true, include: [] },
      server: { port: 0, host: '127.0.0.1', ws: false },
      plugins: [
        bqueryVite({
          i18n: true,
          csp: true,
          ssr: { entry: 'src/entry-server.js' },
          fileRoutes: { onUpdate: (file) => routeUpdates.push(file) },
        }),
      ],
    });
    await server.listen();
    const { port } = server.httpServer!.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    await server.close();
    gzip.upstream.close();
    project.cleanup();
  });

  const get = (pathname: string, accept = 'text/html') =>
    fetch(`${base}${pathname}`, { headers: { accept } });

  const nonceOf = (res: Response) =>
    /'nonce-([^']+)'/.exec(res.headers.get('content-security-policy') ?? '')?.[1];

  it('sends a CSP header whose nonce is stamped on every script and style', async () => {
    const res = await get('/about');
    const nonce = nonceOf(res);
    expect(nonce).toMatch(/^[\w-]{22}$/);
    const html = await res.text();
    expect(html).toContain(`<script type="module" src="/@vite/client" nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain(`<meta property="csp-nonce" nonce="${nonce}">`);
    expect(res.headers.get('content-security-policy')).toContain("object-src 'none'");
  });

  it('renders HTML navigations through the SSR entry with the CSP nonce', async () => {
    const res = await get('/about?x=1');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain(`<div id="app">SSR /about nonce=${nonceOf(res)}</div>`);
    expect(html).toContain('/@vite/client');
  });

  it('supports renderToResponse() from @bquery/bquery/ssr', async () => {
    const res = await get('/bquery');
    expect(res.status).toBe(200);
    const html = await res.text();
    // A full-page template keeps its doctype (bQuery 1.18+), so no quirks mode.
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toMatch(/<h1[^>]*>Rendered by bQuery<\/h1>/);
    expect(html).toContain('/@vite/client');
  });

  it('transforms HTML Responses and keeps their status', async () => {
    const res = await get('/response');
    expect(res.status).toBe(404);
    const html = await res.text();
    expect(html).toContain('<div id="app">resp</div>');
    expect(html).toContain('/@vite/client');
  });

  it('passes non-HTML Responses through untouched', async () => {
    const res = await get('/api-like');
    expect(res.status).toBe(201);
    expect(res.headers.get('x-from')).toBe('entry');
    expect(await res.json()).toEqual({ ok: true });
  });

  it('drops stale encoding headers from a fetched (decoded) Response', async () => {
    const res = await rawGet(
      `${base}/proxied?upstream=${encodeURIComponent(`${gzip.url}/data.json`)}`
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    const length = res.headers['content-length'];
    if (length !== undefined) expect(Number(length)).toBe(Buffer.byteLength(res.body));
    expect(res.body).toBe(gzip.bodies['/data.json'].body);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.headers['x-upstream']).toBe('yes');
    expect(res.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/; HttpOnly']);
    // A decoding client (the browser) reads it too.
    const decoded = await fetch(
      `${base}/proxied?upstream=${encodeURIComponent(`${gzip.url}/data.json`)}`,
      { headers: { accept: 'text/html' } }
    );
    expect(await decoded.json()).toEqual(JSON.parse(gzip.bodies['/data.json'].body));
  });

  it('drops stale encoding headers from a fetched HTML Response', async () => {
    const res = await rawGet(
      `${base}/proxied?upstream=${encodeURIComponent(`${gzip.url}/page.html`)}`
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBeUndefined();
    const length = res.headers['content-length'];
    if (length !== undefined) expect(Number(length)).toBe(Buffer.byteLength(res.body));
    expect(res.body).toContain('upstream upstream');
    expect(res.body).toContain('/@vite/client');
    expect(res.headers['set-cookie']).toEqual(['a=1; Path=/', 'b=2; Path=/; HttpOnly']);
  });

  it('falls through to Vite when render returns null', async () => {
    const res = await get('/fallthrough');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<div id="app"></div>');
  });

  it('reports render errors with a fixed stack trace', async () => {
    const res = await get('/boom');
    expect(res.status).toBe(500);
    await waitFor(() => errors.some((e) => e.includes('render exploded')), 2000, 'error log');
    expect(errors.find((e) => e.includes('render exploded'))).toContain('entry-server.js');
  });

  it('does not render module or asset requests', async () => {
    const res = await get('/src/strings.js', '*/*');
    expect(res.headers.get('content-type')).toContain('javascript');
    expect(res.headers.get('content-security-policy')).toBeNull();
  });

  it('serves compiled views with HMR handling', async () => {
    const main = await server.transformRequest('/src/main.js');
    const url = /"(\/src\/views\/home\.view\.html\?[^"]*bq-view[^"]*)"/.exec(main!.code)?.[1];
    expect(url).toBeDefined();
    // Fetch it the way the browser would.
    const res = await get(url!, '*/*');
    expect(res.headers.get('content-type')).toContain('javascript');
    const code = await res.text();
    expect(code).toContain('"count + 1": (__bq_ctx) => (__bq_ctx.count + 1)');
    expect(code).toContain('import.meta.hot.accept');
    expect(code).toContain('export default template');
  });

  it('recompiles a view after it is edited (HMR re-import)', async () => {
    const main = await server.transformRequest('/src/main.js');
    const url = /"(\/src\/views\/home\.view\.html\?[^"]*bq-view[^"]*)"/.exec(main!.code)?.[1];
    project.write('src/views/home.view.html', '<div><p bq-text="count + 2"></p></div>');
    // The HMR client re-imports the module with a `t=` timestamp.
    await waitFor(
      async () =>
        (await (await get(`${url}&t=${Date.now()}`, '*/*')).text()).includes(
          '"count + 2": (__bq_ctx) => (__bq_ctx.count + 2)'
        ),
      5000,
      'recompiled view'
    );
  });

  it('leaves ?raw and ?url view imports to Vite', async () => {
    const raw = await server.transformRequest('/src/views/page.html?raw');
    expect(raw!.code).toContain('<section bq-show=');
    expect(raw!.code).not.toContain('registerCompiledExpressions');
    const viewRaw = await server.transformRequest('/src/views/home.view.html?raw');
    expect(viewRaw!.code).not.toContain('registerCompiledExpressions');
    expect(viewRaw!.code).toContain('export default');
    const url = await server.transformRequest('/src/views/home.view.html?url');
    expect(url!.code).toContain('export default "/src/views/home.view.html"');
  });

  it('regenerates virtual:bquery/routes when a route file is added', async () => {
    const before = await server.ssrLoadModule('virtual:bquery/routes');
    expect(before.routes.map((r: { path: string }) => r.path)).toEqual(['/', '/users/:id']);

    project.write('src/routes/about.ts', "export default 'about';");
    await waitFor(() => routeUpdates.some((f) => f.endsWith('about.ts')), 5000, 'route add');
    const after = await server.ssrLoadModule('virtual:bquery/routes');
    expect(after.routes.map((r: { path: string }) => r.path)).toEqual([
      '/about',
      '/',
      '/users/:id',
    ]);
    expect(Object.keys(after.layouts)).toEqual(['/']);
  });

  it('re-extracts messages when a source file changes', async () => {
    const messages = await server.ssrLoadModule('virtual:bquery/messages');
    expect(messages.locales).toEqual(['en']);
    expect(messages.messages.en.nav.home).toBe('Home');

    project.write('src/strings.js', `${SAMPLE_FILES['src/strings.js']}\nt('footer.legal');`);
    await waitFor(
      () => JSON.parse(project.read('locales/en.json')).footer?.legal === '',
      5000,
      'catalog update'
    );
    // The catalog is a watched file of virtual:bquery/messages, so it reloads.
    await waitFor(
      async () =>
        (await server.ssrLoadModule('virtual:bquery/messages')).messages.en.footer?.legal === '',
      5000,
      'messages module update'
    );
  });
});
