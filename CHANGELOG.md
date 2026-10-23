# Changelog

All notable changes to `@bquery/unplugin` are documented in this file. The
format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the
project uses [Semantic Versioning](https://semver.org/).

## Unreleased

### Added

- `@bquery/unplugin` — a bundler plugin for Vite, Rollup, webpack, Rspack and esbuild ([bQuery/bQuery#224](https://github.com/bQuery/bQuery/issues/224), developed in [bQuery/bQuery#278](https://github.com/bQuery/bQuery/pull/278)). It compiles `*.view.html` imports with the view compiler (HMR in Vite), generates the file-route manifest as `virtual:bquery/routes`, extracts i18n messages into the catalogs in watch mode (`virtual:bquery/messages` hot-reloads them), and in Vite dev adds a CSP nonce and an SSR middleware for a `render(request, ctx)` server entry. Requires `@bquery/bquery` 1.18.0 or later.

### Changed

- Requires `@bquery/bquery` 1.18.0 or later (peer and dev dependency `^1.18.0`, was `^1.17.2`). `bq-on` handlers with several `;`-separated statements (`$event.preventDefault(); add()`) now always compile: the view compiler puts them in a separate statements map that the emitted module passes to `registerCompiledExpressions(expressions, statements)`, instead of leaving them to the runtime evaluator with a warning as 1.17.2 did. bQuery 1.18 also keeps the `<!DOCTYPE html>` of full-page templates in its SSR renderers, so pages served by the SSR dev middleware no longer fall into quirks mode.
