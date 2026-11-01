import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, readFile, writeFile, rm, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { request } from 'node:http';
import { stringify as toYaml, parse as parseYaml } from 'yaml';
import { fixture, commitFixture } from './test-fixture.mjs';
import { git } from './workspace.mjs';
import { startApiDocs, docsHost, docsPort, docsSchemaPath } from './api-docs.mjs';

// Every shape the issue asks Swagger UI to display: parameters, a request body, an authenticated endpoint, nullable, enum and an array response.
// The OpenAPI on main is the approved contract, so the docs read it as it is (#164).
async function sourceOfTruth(root) {
  await copyFile(new URL('./fixtures/profile-docs-openapi.yaml', import.meta.url), join(root, docsSchemaPath));
  await commitFixture(root);
}
function get(server, path, { method = 'GET', headers = {} } = {}) {
  const { address, port } = server.address();
  return new Promise((resolve, reject) => {
    const req = request({ host: address, port, path, method, headers: { host: `${address}:${port}`, ...headers } }, res => {
      let body = '';
      res.setEncoding('utf8').on('data', chunk => { body += chunk; }).on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject).end();
  });
}
const withDocs = async (root, test) => {
  const docs = await startApiDocs({ root, port: 0 });
  try { await test(docs); } finally { await new Promise(resolve => docs.server.close(resolve)); }
};
const remoteUrl = /https?:\/\//;

describe('API Docs Server', () => {
  describe('given the OpenAPI 3.1 Source of Truth', () => {
    it('when api:docs starts then it defaults to 127.0.0.1:8080 and listens only on the loopback address', () => fixture(async root => {
      await sourceOfTruth(root);
      assert.deepEqual([docsHost, docsPort, docsSchemaPath], ['127.0.0.1', 8080, 'packages/api-schema/openapi.yaml']);
      await withDocs(root, async docs => {
        assert.equal(docs.server.address().address, '127.0.0.1');
        assert.equal(docs.url, `http://127.0.0.1:${docs.server.address().port}`);
        assert.equal(docs.schemaPath, docsSchemaPath);
      });
    }));
    it('when the browser loads the page then Swagger UI reads /openapi.yaml with Try it out and the online validator disabled', () => fixture(async root => {
      await sourceOfTruth(root);
      await withDocs(root, async docs => {
        const page = await get(docs.server, '/');
        assert.equal(page.status, 200);
        assert.match(page.headers['content-type'], /text\/html/);
        for (const asset of ['swagger-ui.css', 'swagger-ui-bundle.js', 'swagger-initializer.js']) {
          assert.ok(page.body.includes(asset), `page loads ${asset}`);
          assert.equal((await get(docs.server, `/${asset}`)).status, 200);
        }
        const initializer = (await get(docs.server, '/swagger-initializer.js')).body;
        assert.match(initializer, /url: '\/openapi\.yaml'/);
        assert.match(initializer, /supportedSubmitMethods: \[\]/);
        assert.match(initializer, /tryItOutEnabled: false/);
        assert.match(initializer, /validatorUrl: null/);
        assert.doesNotMatch(initializer, /StandalonePreset/, 'no top bar that loads another URL');
        assert.doesNotMatch(page.body + initializer, remoteUrl);
      });
    }));
    it('when the page is served then the Content Security Policy only lets the browser connect to this server', () => fixture(async root => {
      await sourceOfTruth(root);
      await withDocs(root, async docs => {
        for (const path of ['/', '/openapi.yaml', '/swagger-initializer.js']) {
          const csp = (await get(docs.server, path)).headers['content-security-policy'];
          assert.match(csp, /default-src 'none'/);
          assert.match(csp, /connect-src 'self'/);
          assert.match(csp, /script-src 'self'(;|$)/);
          assert.doesNotMatch(csp, remoteUrl);
        }
      });
    }));
    it('when /openapi.yaml is requested then serves the Source of Truth itself, including later edits, without copying it', () => fixture(async root => {
      await sourceOfTruth(root);
      await withDocs(root, async docs => {
        const served = await get(docs.server, '/openapi.yaml');
        assert.equal(served.status, 200);
        assert.equal(served.body, await readFile(join(root, docsSchemaPath), 'utf8'));
        const document = parseYaml(served.body);
        assert.equal(document.openapi, '3.1.0');
        assert.ok(document.paths['/api/v1/me/profile'].patch.requestBody);
        assert.equal(document.paths['/api/v1/courses/{courseId}/lessons'].get.parameters[0].in, 'path');
        const used = document.paths['/api/v1/me/profile'].get.security.flatMap(Object.keys);
        assert.ok(used.length > 0, 'the authenticated endpoint names a security scheme');
        for (const name of used) assert.ok(document.components.securitySchemes[name]?.type, `securityScheme ${name} is defined`);
        assert.deepEqual(document.components.schemas.Profile.properties.bio.type, ['string', 'null']);
        assert.deepEqual(document.components.schemas.Profile.properties.role.enum, ['student', 'mentor']);
        await appendFile(join(root, docsSchemaPath), '# edited\n');
        assert.match((await get(docs.server, '/openapi.yaml')).body, /# edited\n$/);
        await git(root, ['checkout', '--', docsSchemaPath]);
        assert.equal((await git(root, ['status', '--porcelain', '--untracked-files=all'])).stdout, '', 'api:docs writes no file into the repository');
      });
    }));
    it('when the Source of Truth lists production servers then the page still talks to nothing but this server', () => fixture(async root => {
      await sourceOfTruth(root);
      const document = parseYaml(await readFile(join(root, docsSchemaPath), 'utf8'));
      await writeFile(join(root, docsSchemaPath), toYaml({ ...document, servers: [{ url: 'https://api.example.com' }, { url: 'https://staging-api.example.com' }] }));
      await withDocs(root, async docs => {
        const initializer = (await get(docs.server, '/swagger-initializer.js')).body;
        assert.match(initializer, /supportedSubmitMethods: \[\]/);
        assert.match((await get(docs.server, '/')).headers['content-security-policy'], /connect-src 'self'/);
      });
    }));
  });

  describe('given a running docs server and a request it must not answer', () => {
    for (const path of ['/../package.json', '/%2e%2e/package.json', '/package.json', '/index.html', '/swagger-ui-standalone-preset.js', '/oauth2-redirect.html']) {
      it(`when ${path} is requested then answers 404 instead of serving another file`, () => fixture(async root => {
        await sourceOfTruth(root);
        await withDocs(root, async docs => assert.equal((await get(docs.server, path)).status, 404));
      }));
    }
    it('when a request uses another method than GET or HEAD then answers 405', () => fixture(async root => {
      await sourceOfTruth(root);
      await withDocs(root, async docs => assert.equal((await get(docs.server, '/openapi.yaml', { method: 'POST' })).status, 405));
    }));
    it('when a request names another host then answers 403 so that a rebound DNS name cannot read the schema', () => fixture(async root => {
      await sourceOfTruth(root);
      await withDocs(root, async docs => assert.equal((await get(docs.server, '/openapi.yaml', { headers: { host: 'attacker.example:8080' } })).status, 403));
    }));
  });

  describe('given a Source of Truth that cannot be shown as is', () => {
    const refused = async (root, pattern) => {
      await assert.rejects(startApiDocs({ root, port: 0 }), pattern);
    };
    // main tracks the OpenAPI of the health check (SBI #232), so the fixture removes it to stand for a repository without one.
    it('when packages/api-schema/openapi.yaml does not exist then refuses and names the file', () => fixture(async root => {
      await rm(join(root, docsSchemaPath));
      await refused(root, /packages\/api-schema\/openapi\.yaml/);
    }));
    it('when the Source of Truth is openapi.json instead of openapi.yaml then refuses', () => fixture(async root => {
      await rm(join(root, docsSchemaPath));
      await writeFile(join(root, 'packages/api-schema/openapi.json'), JSON.stringify({ openapi: '3.1.0', info: { title: 'SONOMAMA API', version: '0.1.0' }, paths: {} }));
      await refused(root, /packages\/api-schema\/openapi\.yaml/);
    }));
    it('when the Source of Truth is OpenAPI 3.0 then refuses', () => fixture(async root => {
      await writeFile(join(root, docsSchemaPath), toYaml({ openapi: '3.0.3', info: { title: 'SONOMAMA API', version: '0.1.0' }, paths: {} }));
      await refused(root, /3\.1/);
    }));
    it('when the Source of Truth refers to a remote document then refuses so that the browser never fetches it', () => fixture(async root => {
      await writeFile(join(root, docsSchemaPath), toYaml({
        openapi: '3.1.0', info: { title: 'SONOMAMA API', version: '0.1.0' },
        paths: { '/api/v1/health': { get: { operationId: 'getHealth', responses: { 200: { description: 'OK', content: { 'application/json': { schema: { $ref: 'https://example.com/schemas/health.json' } } } } } } } },
      }));
      await refused(root, /\$ref[\s\S]*https:\/\/example\.com/);
    }));
    it('when the Source of Truth starts referring to a remote document while the server runs then stops serving it', () => fixture(async root => {
      await sourceOfTruth(root);
      await withDocs(root, async docs => {
        const document = parseYaml(await readFile(join(root, docsSchemaPath), 'utf8'));
        document.components.schemas.Remote = { $ref: 'https://example.com/schemas/remote.json' };
        await writeFile(join(root, docsSchemaPath), toYaml(document));
        const served = await get(docs.server, '/openapi.yaml');
        assert.equal(served.status, 422);
        assert.doesNotMatch(served.body, /openapi: 3\.1/);
        await rm(join(root, docsSchemaPath));
        assert.equal((await get(docs.server, '/openapi.yaml')).status, 422);
      });
    }));
    it('when swagger-ui-dist is not installed then refuses and tells to run pnpm install', () => fixture(async root => {
      await sourceOfTruth(root);
      const started = startApiDocs({ root, port: 0, swaggerUi: join(root, 'node_modules/swagger-ui-dist') });
      started.then(docs => docs.server.close(), () => {});
      await assert.rejects(started, /pnpm install/);
    }));
    it('when the port is already in use then refuses with a message that names the port', () => fixture(async root => {
      await sourceOfTruth(root);
      await withDocs(root, async docs => {
        await assert.rejects(startApiDocs({ root, port: docs.server.address().port }), new RegExp(`${docs.server.address().port}.*使用中|--port`));
      });
    }));
  });
});
