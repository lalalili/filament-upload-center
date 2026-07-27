# Filament Upload Center

Reusable browser-to-S3 upload queue for Filament hosts. The package owns the Uppy queue, progress rendering, retry and browser restore metadata; each host supplies an adapter for its own session API.

## Install

Until the npm registry release is configured, install the public GitHub release directly:

```bash
pnpm add @lalalili/filament-upload-center@github:lalalili/filament-upload-center#v0.1.11
```

The package requires Vite and Uppy. Its declared dependencies install the supported Uppy modules automatically.

## Host contract

Call `createUploadCenter(root, { adapter, allowedFileTypes, context })`. The adapter creates a server-side session, returns direct-upload parameters or multipart signatures, lists persisted parts, completes, cancels and polls its own domain status. Browser uploads never receive cloud credentials or application API tokens.

For multipart resume, the host must retain its upload session and expose an authoritative `listParts` response. When a browser no longer has a source file, prompt the user to reselect the same file and continue from server-confirmed parts.

## DOM contract

`createUploadCenter(root, options)` looks up five child elements inside `root`
with `querySelector`. **The host must render markup providing all of them** —
the package's own `filament-upload-center::mount` view renders only the outer
container (`data-filament-upload-center`), not the inner structure.

| Attribute | Purpose |
|---|---|
| `data-upload-input` | The `<input type="file">` the queue reads selections from |
| `data-upload-dropzone` | Drop target for drag-and-drop uploads |
| `data-upload-list` | Container the per-file rows are rendered into |
| `data-upload-count` | Element showing the queued/completed counter |
| `data-upload-notifications` | Container for inline status and error messages |

Missing any of these makes the queue fail silently rather than error, so the
contract is pinned by `tests/Unit/DomContractTest.php`: it parses the selectors
out of `resources/js/upload-center.js` and asserts they match this table
exactly. Changing a selector on either side fails CI.

## Host dependencies

Install `@uppy/core`, `@uppy/aws-s3` and `@uppy/golden-retriever` in the host build. Add the package source as a Vite dependency or published package, and keep the host's CSRF/session requests same-origin.
