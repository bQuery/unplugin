import { afterAll, describe, expect, it } from 'bun:test';
import { statSync } from 'node:fs';
import { transform } from 'esbuild';
import bquery, {
  buildCspPolicy,
  buildViewModule,
  generateMessagesModule,
  generateRoutesModule,
  MESSAGES_MODULE_ID,
  ROUTES_MODULE_ID,
  scanRouteFiles,
  unpluginFactory,
} from '../index.js';
import bqueryEsbuild from '../esbuild.js';
import bqueryRollup from '../rollup.js';
import bqueryRspack from '../rspack.js';
import bqueryVite from '../vite.js';
import bqueryWebpack from '../webpack.js';
import { createFilter, globToRegExp, toJsLiteral, writeIfChanged } from '../src/utils.js';
import { isViewQuery } from '../src/views.js';
import { createProject, SAMPLE_FILES } from './helpers';

const names = (plugins: Array<{ name: string }>) => plugins.map((plugin) => plugin.name);

describe('adapters', () => {
  it('exposes every bundler adapter as a function', () => {
    for (const adapter of [bqueryVite, bqueryRollup, bqueryWebpack, bqueryRspack, bqueryEsbuild]) {
      expect(typeof adapter).toBe('function');
    }
    for (const name of ['vite', 'rollup', 'webpack', 'rspack', 'esbuild'] as const) {
      expect(typeof bquery[name]).toBe('function');
    }
  });

  it('creates webpack/rspack plugin instances without the bundler installed', () => {
    expect(typeof bqueryWebpack().apply).toBe('function');
    expect(typeof bqueryRspack().apply).toBe('function');
  });

  it('returns one Vite plugin per enabled feature', () => {
    const plugins = bqueryVite({ i18n: true, csp: true, ssr: true }) as Array<{ name: string }>;
    expect(names(plugins)).toEqual([
      'bquery',
      'bquery:views',
      'bquery:routes',
      'bquery:i18n',
      'bquery:csp',
      'bquery:ssr',
    ]);
  });

  it('enables views and file routes by default, the rest on demand', () => {
    expect(names(unpluginFactory({}, { framework: 'rollup', versions: {} }))).toEqual([
      'bquery',
      'bquery:views',
      'bquery:routes',
    ]);
    expect(
      names(
        unpluginFactory({ views: false, fileRoutes: false }, { framework: 'vite', versions: {} })
      )
    ).toEqual(['bquery']);
  });

  it('drops the Vite-only csp/ssr features for other bundlers', () => {
    const plugins = unpluginFactory(
      { csp: true, ssr: true },
      { framework: 'esbuild', versions: {} }
    );
    expect(names(plugins)).not.toContain('bquery:csp');
    expect(names(plugins)).not.toContain('bquery:ssr');
  });

  it('exports the virtual module ids', () => {
    expect(ROUTES_MODULE_ID).toBe('virtual:bquery/routes');
    expect(MESSAGES_MODULE_ID).toBe('virtual:bquery/messages');
  });
});

describe('utils', () => {
  it('converts globs with **, * and {a,b}', () => {
    const re = globToRegExp('src/**/*.{ts,js}');
    expect(re.test('src/a.ts')).toBe(true);
    expect(re.test('src/deep/er/a.js')).toBe(true);
    expect(re.test('src/a.css')).toBe(false);
    expect(re.test('lib/a.ts')).toBe(false);
    expect(globToRegExp('**/*.view.html').test('home.view.html')).toBe(true);
  });

  it('builds include/exclude filters from globs, RegExps and functions', () => {
    const filter = createFilter('/proj', ['src/**/*.ts', /\.mjs$/], ['src/skip/**']);
    expect(filter('/proj/src/a.ts')).toBe(true);
    expect(filter('/proj/src/skip/a.ts')).toBe(false);
    expect(filter('/proj/lib/x.mjs')).toBe(true);
    expect(filter('/proj/src/a.ts?query')).toBe(true);
    expect(createFilter('/proj', (file: string) => file.endsWith('.x'))('/proj/a.x')).toBe(true);
  });

  it('writes only when the content changes', async () => {
    const project = createProject({ 'a.txt': 'same' });
    try {
      const before = statSync(project.path('a.txt')).mtimeMs;
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await writeIfChanged(project.path('a.txt'), 'same')).toBe(false);
      expect(statSync(project.path('a.txt')).mtimeMs).toBe(before);
      expect(await writeIfChanged(project.path('a.txt'), 'new')).toBe(true);
      expect(await writeIfChanged(project.path('nested/b.txt'), 'b')).toBe(true);
      expect(project.read('nested/b.txt')).toBe('b');
    } finally {
      project.cleanup();
    }
  });
});

describe('generators', () => {
  it('escapes markup and line separators in generated literals', () => {
    const value = { file: '/x/</script><img onerror=alert(1)>.ts', text: 'a\u2028b\u2029c' };
    const literal = toJsLiteral(value);
    expect(literal).not.toMatch(/[<>\u2028\u2029]/);
    expect(new Function(`return ${literal};`)()).toEqual(value);

    const module = generateRoutesModule(
      [
        {
          key: '/src/routes/</script>.ts',
          file: '/p/src/routes/</script>.ts',
          kind: 'page',
          pattern: '/',
        },
      ],
      {},
      '/p'
    );
    expect(module).not.toContain('</script>');
    expect(module).toContain('\\u003c/script\\u003e');
  });

  const project = createProject(SAMPLE_FILES);
  afterAll(() => project.cleanup());

  it('emits a self-registering view module with the template as default export', () => {
    const { code, stats } = buildViewModule('<p bq-text="a + 1"></p>', {}, false);
    expect(code).toContain('registerCompiledExpressions');
    expect(code).toContain('"a + 1": (__bq_ctx) => (__bq_ctx.a + 1)');
    expect(code).toContain('export default template;');
    expect(code).not.toContain('import.meta.hot');
    expect(stats).toEqual({ total: 1, compiled: 1, skipped: [] });
  });

  it('compiles bq-on statement lists into the statements map', async () => {
    const handler = '$event.preventDefault(); add()';
    const { code, stats } = buildViewModule(
      `<form bq-on:submit="${handler}"><p bq-text="count"></p></form>`,
      {},
      false
    );
    expect(stats).toEqual({ total: 2, compiled: 2, skipped: [] });

    // Run the emitted module against a stub registry to see what it registers.
    const calls: Array<Array<Record<string, (ctx: unknown) => unknown>>> = [];
    const { code: cjs } = await transform(code, { format: 'cjs', loader: 'js' });
    const run = new Function('require', 'module', 'exports', cjs);
    const module = { exports: {} as Record<string, unknown> };
    run(
      () => ({
        registerCompiledExpressions: (...args: (typeof calls)[number]) => calls.push(args),
      }),
      module,
      module.exports
    );
    expect(calls).toHaveLength(1);
    const [expressions, statements] = calls[0]!;
    expect(Object.keys(expressions!)).toEqual(['count']);
    expect(Object.keys(statements!)).toEqual([handler]);

    // Both statements run in order; the last one's value is the handler's value.
    const order: string[] = [];
    const ctx = {
      $event: { preventDefault: () => order.push('preventDefault') },
      add: () => (order.push('add'), 'added'),
    };
    expect(statements![handler]!(ctx)).toBe('added');
    expect(order).toEqual(['preventDefault', 'add']);
    expect(module.exports.default).toContain(`bq-on:submit="${handler}"`);
  });

  it('leaves a statement list outside bq-on to the runtime evaluator', () => {
    const { stats } = buildViewModule('<p bq-show="a(); b()"></p>', {}, false);
    expect(stats.compiled).toBe(0);
    expect(stats.skipped.map((entry) => entry.expression)).toEqual(['a(); b()']);
  });

  it('compiles only bare view imports or the view marker', () => {
    for (const id of ['a.view.html', 'a.html?bq-view', 'a.html?import&bq-view&t=123']) {
      expect(isViewQuery(id, 'bq-view')).toBe(true);
    }
    for (const id of ['a.view.html?raw', 'a.view.html?url', 'a.html?bq-view&inline']) {
      expect(isViewQuery(id, 'bq-view')).toBe(false);
    }
  });

  it('adds HMR handling and honours the import specifier', () => {
    const { code } = buildViewModule('<p bq-text="a"></p>', { importSpecifier: 'my-view' }, true);
    expect(code).toContain('from "my-view"');
    expect(code).toContain('import.meta.hot.accept');
    expect(code).toContain('import.meta.hot.invalidate');
  });

  it('scans route files, skipping +server endpoints', async () => {
    const records = await scanRouteFiles({}, project.root);
    expect(records.map((record) => [record.key, record.kind, record.pattern])).toEqual([
      ['/src/routes/+layout.ts', 'layout', '/'],
      ['/src/routes/index.ts', 'page', '/'],
      ['/src/routes/users/[id]/+page.ts', 'page', '/users/:id'],
    ]);
  });

  it('generates a lazy or eager manifest module', async () => {
    const records = await scanRouteFiles({}, project.root);
    const lazy = generateRoutesModule(records, {}, project.root);
    expect(lazy).toContain('import { createFileRoutes } from "@bquery/bquery/router"');
    expect(lazy).toContain('"/src/routes/index.ts": () => import(');
    expect(lazy).toContain('export const options = {"routesDir":"src/routes"};');
    const eager = generateRoutesModule(records, { eager: true, routerImport: 'r' }, project.root);
    expect(eager).toContain('import * as __bq_route_0 from');
    expect(eager).toContain('"/": __bq_route_0,');
    expect(eager).toContain('from "r"');
  });

  it('generates the messages module with a hotReload helper', () => {
    const plain = generateMessagesModule({ en: { a: 'A' } }, false);
    expect(plain).toContain('export const locales = ["en"];');
    expect(plain).toContain('export function hotReload(i18n) { return i18n; }');
    expect(generateMessagesModule({ en: {} }, true)).toContain('i18n.mergeMessages(locale');
  });

  it('builds a CSP policy that always carries the nonce', () => {
    const policy = buildCspPolicy('abc');
    expect(policy).toContain("script-src 'self' 'nonce-abc'");
    expect(policy).toContain("style-src 'self' 'nonce-abc'");
    const custom = buildCspPolicy('abc', {
      'script-src': ["'self'", "'unsafe-eval'"],
      'img-src': false,
    });
    expect(custom).toContain("script-src 'self' 'unsafe-eval' 'nonce-abc'");
    expect(custom).not.toContain('img-src');
  });
});
