# @bquery/unplugin

The official bundler plugin for [bQuery](https://bquery.js.org). It is built on
[unplugin](https://unplugin.unjs.io/): one implementation, with adapters for
**Vite**, **Rollup**, **webpack**, **Rspack** and **esbuild**.

- **Views** (on by default): imports of `*.view.html` and `*.html?bq-view` are
  precompiled with `@bquery/bquery/view/compiler`. The output is CSP-safe and
  never calls `new Function()`. Supports HMR in Vite.
- **File routes** (on by default): `virtual:bquery/routes` builds the route
  table from `src/routes` with `createFileRoutes()`, using lazy `import()`.
  It regenerates when files are added or removed in Vite.
- **i18n** (opt-in): keeps JSON catalogs in sync with `t()` / `tc()` /
  `defineMessages()` in your source, and serves them as
  `virtual:bquery/messages` with hot reloading in Vite.
- **CSP** (opt-in, Vite only): stamps a nonce on every script and style tag in
  dev and sends a matching `Content-Security-Policy` header.
- **SSR** (opt-in, Vite only): a dev middleware that renders HTML navigations
  through your server entry with `ssrLoadModule()`.

bQuery itself stays zero-build: nothing here is needed to use the library from a
CDN or without a bundler.

## Install

```sh
npm install -D @bquery/unplugin
# or
bun add -d @bquery/unplugin
# or
pnpm add -D @bquery/unplugin
```

`@bquery/bquery` (`^1.18.0`) is a peer dependency. Install the bundler you use;
each one (`vite`, `rollup`, `webpack`, `@rspack/core`, `esbuild`) is an optional
peer dependency.

## Setup

All adapters take the same [options](#options).

### Vite

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import bquery from '@bquery/unplugin/vite';

export default defineConfig({
  plugins: [
    bquery({
      i18n: { catalog: 'locales/en.json', locales: ['locales/de.json'] },
      csp: true,
      ssr: { entry: 'src/entry-server.ts' },
    }),
  ],
});
```

### Rollup

```js
// rollup.config.js
import bquery from '@bquery/unplugin/rollup';
import { nodeResolve } from '@rollup/plugin-node-resolve';

export default {
  input: 'src/main.ts',
  output: { dir: 'dist', format: 'es' },
  plugins: [bquery({ i18n: true }), nodeResolve()],
};
```

### webpack

```js
// webpack.config.js
import bquery from '@bquery/unplugin/webpack';

export default {
  entry: './src/main.ts',
  plugins: [bquery({ i18n: true })],
};
```

### Rspack

```js
// rspack.config.js
import bquery from '@bquery/unplugin/rspack';

export default {
  entry: './src/main.ts',
  plugins: [bquery({ i18n: true })],
};
```

### esbuild

```js
// build.mjs
import { build } from 'esbuild';
import bquery from '@bquery/unplugin/esbuild';

await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  format: 'esm',
  splitting: true,
  outdir: 'dist',
  plugins: [bquery({ i18n: true })],
});
```

The root export also gives access to every adapter:
`import { bquery } from '@bquery/unplugin'`, then `bquery.vite()`,
`bquery.rollup()`, and so on.

### TypeScript

To type the virtual modules and template imports, reference the client types
once, for example in `src/env.d.ts`:

```ts
/// <reference types="@bquery/unplugin/client" />
```

## Usage

```ts
import { createRouter } from '@bquery/bquery/router';
import { createI18n } from '@bquery/bquery/i18n';
import { routes } from 'virtual:bquery/routes';
import { messages, hotReload } from 'virtual:bquery/messages';
import template from './views/app.view.html'; // registers the compiled expressions

const router = createRouter({ routes });
const i18n = hotReload(createI18n({ locale: 'en', messages }));
```

A template import becomes the module the view compiler emits: it calls
`registerCompiledExpressions()` when it runs, and its default export is the
markup. Import the template before you `mount()` it. Expressions the compiler
cannot handle keep working through the runtime evaluator, and the plugin emits
one warning for each of them. Only bare template imports are compiled: an
import with a query of its own (`./home.view.html?raw`, `?url`, `?inline`) is
left to the bundler and its other plugins.

The SSR entry exports `render(request: Request, ctx)`. `ctx` holds `url`,
`template`, `nonce`, `dev` and `server`. `render` returns an HTML string, a
`Response`, or `null` to fall through to the next middleware. A `Response`
keeps its status and headers, except `content-encoding`, `content-length` and
hop-by-hop headers: its body is read decoded (as `fetch()` returns it), so
those no longer describe what the middleware sends. Every `Set-Cookie` is kept.

bQuery's SSR renderers drop every `<script>` from the template, including the
`<script type="module" src="/src/main.ts">` client entry of `index.html`. Add
the entry through the SSR context instead; it is injected once and gets the
CSP nonce:

```ts
import { createSSRContext, renderToResponse } from '@bquery/bquery/ssr';

export async function render(request: Request, ctx) {
  const ssr = createSSRContext({ request, nonce: ctx.nonce });
  ssr.head.add({ script: [{ src: '/src/main.ts', module: true }] });
  return renderToResponse(ctx.template, { title: 'Home' }, { context: ssr });
}
```

## Options

```ts
interface BQueryPluginOptions {
  root?: string; // default: Vite root, webpack/Rspack `context`, esbuild `absWorkingDir`, or cwd
  views?: boolean | ViewsOptions; // default: enabled
  fileRoutes?: boolean | FileRoutesOptions; // default: enabled (active only when imported)
  i18n?: boolean | I18nOptions; // default: disabled
  csp?: boolean | CspOptions; // default: disabled; Vite only
  ssr?: boolean | SsrOptions; // default: disabled; Vite only
}
```

Pass `true` to turn a feature on with its defaults, or `false` to turn it off.
Every option is documented in [`index.d.ts`](./index.d.ts) and in the
[bundler plugin guide](https://bquery.js.org/guide/bundler-plugin), together
with the render contract and the limitations.

## Compatibility

- Node.js 24+ or Bun 1.4+.
- `@bquery/bquery` 1.18.0 or later. `bq-on` handlers with several
  `;`-separated statements (`$event.preventDefault(); add()`) are compiled
  like single expressions.
- `csp` and `ssr` need the Vite dev server; other bundlers ignore them with
  one warning per build. webpack and Rspack use the same code paths through
  unplugin's adapters but are not covered by this package's test suite.

## Development

```sh
bun install
bun run typecheck
bun run lint
bun run format:check
bun test # real Rollup, esbuild and Vite builds plus a Vite dev server
```

## License

[MIT](./LICENSE.md)
