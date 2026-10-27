import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { exists } from './io.mjs';
import { readExistingSchema } from './api-schema-reader.mjs';
import { externalRefs } from './api-mock.mjs';

// Swagger UI shows the OpenAPI Source of Truth as it is, for reading only. It never sends a request to an API in the document.
export const docsSchemaPath = 'packages/api-schema/openapi.yaml';
export const docsHost = '127.0.0.1';
export const docsPort = 8080;
// Resolved from the harness source, not the target root: the repository pins the swagger-ui-dist version.
const swaggerUiDist = fileURLToPath(new URL('../../node_modules/swagger-ui-dist/', import.meta.url));
const assets = { '/swagger-ui.css': 'text/css', '/swagger-ui-bundle.js': 'text/javascript', '/favicon-32x32.png': 'image/png' };
const page = `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>SONOMAMA API</title>
<link rel="stylesheet" href="/swagger-ui.css">
<link rel="icon" type="image/png" href="/favicon-32x32.png">
</head>
<body>
<div id="swagger-ui"></div>
<script src="/swagger-ui-bundle.js"></script>
<script src="/swagger-initializer.js"></script>
</body>
</html>
`;
// No StandalonePreset: its top bar loads any URL typed into it. Try it out is off so the servers in the document are never called,
// and validatorUrl is null because the default sends the document to validator.swagger.io.
const initializer = `window.ui = SwaggerUIBundle({
  url: '/openapi.yaml',
  dom_id: '#swagger-ui',
  presets: [SwaggerUIBundle.presets.apis],
  layout: 'BaseLayout',
  deepLinking: true,
  supportedSubmitMethods: [],
  tryItOutEnabled: false,
  validatorUrl: null,
});
`;
// The browser enforces what the configuration intends: it may load and fetch only from this server.
const headers = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
};

// Read on every request so the page always shows the current file; nothing is copied.
async function readSourceOfTruth(root) {
  const existing = await readExistingSchema(root);
  if (existing?.path !== docsSchemaPath) throw new Error(`${docsSchemaPath} がありません。承認済みのOpenAPIを反映してから起動してください`);
  const text = await readFile(join(root, docsSchemaPath), 'utf8');
  const remote = externalRefs(parseYaml(text));
  if (remote.length) throw new Error(`${docsSchemaPath} がローカル以外の$refを参照しています（${remote.join(', ')}）。Swagger UIで表示しません`);
  return text;
}

export async function startApiDocs({ root, port = docsPort, swaggerUi = swaggerUiDist }) {
  await readSourceOfTruth(root);
  if (!await exists(join(swaggerUi, 'swagger-ui-bundle.js'))) throw new Error('swagger-ui-distがインストールされていません。pnpm installを実行してください');
  const server = createServer(async (req, res) => {
    const send = (status, type, body) => {
      res.writeHead(status, { ...headers, 'content-type': type });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    const { port: listening } = server.address();
    if (![`${docsHost}:${listening}`, `localhost:${listening}`].includes(req.headers.host)) return send(403, 'text/plain; charset=utf-8', 'Forbidden');
    if (!['GET', 'HEAD'].includes(req.method)) return send(405, 'text/plain; charset=utf-8', 'Method Not Allowed');
    const path = req.url.split('?')[0];
    try {
      if (path === '/') return send(200, 'text/html; charset=utf-8', page);
      if (path === '/swagger-initializer.js') return send(200, 'text/javascript; charset=utf-8', initializer);
      if (path === '/openapi.yaml') {
        let text;
        try { text = await readSourceOfTruth(root); } catch (error) { return send(422, 'text/plain; charset=utf-8', error.message); }
        return send(200, 'application/yaml; charset=utf-8', text);
      }
      if (Object.hasOwn(assets, path)) return send(200, assets[path], await readFile(join(swaggerUi, path.slice(1))));
      return send(404, 'text/plain; charset=utf-8', 'Not Found');
    } catch { return send(500, 'text/plain; charset=utf-8', 'Internal Server Error'); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', error => reject(error.code === 'EADDRINUSE' ? new Error(`${docsHost}:${port} は使用中です。--port で別のポートを指定してください`) : error));
    server.listen(port, docsHost, resolve);
  });
  return { schemaPath: docsSchemaPath, url: `http://${docsHost}:${server.address().port}`, server };
}
