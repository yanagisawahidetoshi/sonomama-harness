import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { diffContract } from './api-schema-diff.mjs';

const ref = name => ({ $ref: `#/components/parameters/${name}` });
const query = (name, required = false) => ({ name, in: 'query', required, schema: { type: 'string' } });
const document = parameters => ({
  openapi: '3.1.0', info: { title: 'x', version: '1' },
  paths: { '/api/v1/items': { get: { operationId: 'listItems', parameters, responses: { 200: { description: 'OK' } } } } },
  components: { parameters: { Locale: query('locale'), Page: query('page'), Tenant: { name: 'X-Tenant', in: 'header', required: true, schema: { type: 'string' } } } },
});
const at = suffix => `paths./api/v1/items.get.parameters${suffix}`;
const lines = result => [...result.breaking, ...result.nonBreaking];

describe('Contract diff of $ref parameters', () => {
  describe('given an operation whose parameters are $ref only', () => {
    it('when one of two $ref parameters is replaced by another then reports the dropped one as breaking and the new one as added', () => {
      const result = diffContract(document([ref('Locale'), ref('Page')]), document([ref('Locale'), ref('Tenant')]));
      assert.ok(result.breaking.some(line => line.startsWith('削除: ') && line.includes(at('[$ref:#/components/parameters/Page]'))), JSON.stringify(result));
      assert.ok(lines(result).some(line => line.includes(at('[$ref:#/components/parameters/Tenant]'))), JSON.stringify(result));
      assert.ok(!lines(result).some(line => line.includes('Locale')), JSON.stringify(result));
    });
    it('when the $ref parameters are only reordered then reports no difference', () => {
      assert.deepEqual(diffContract(document([ref('Locale'), ref('Page')]), document([ref('Page'), ref('Locale')])), { breaking: [], nonBreaking: [] });
    });
    it('when a $ref parameter is removed then reports it as breaking by its reference', () => {
      const result = diffContract(document([ref('Locale'), ref('Page')]), document([ref('Locale')]));
      assert.deepEqual(result.breaking, [`削除: ${at('[$ref:#/components/parameters/Page]')}`]);
    });
    it('when an optional $ref parameter is added then reports it as non-breaking by its reference', () => {
      const result = diffContract(document([ref('Locale')]), document([ref('Locale'), ref('Page')]));
      assert.deepEqual(result, { breaking: [], nonBreaking: [`追加: ${at('[$ref:#/components/parameters/Page]')}`] });
    });
    it('when a $ref parameter whose referenced parameter is required is added then reports it as breaking', () => {
      const result = diffContract(document([ref('Locale')]), document([ref('Locale'), ref('Tenant')]));
      assert.deepEqual(result.breaking, [`必須parameterを追加: ${at('[$ref:#/components/parameters/Tenant]')}`]);
    });
    it('when a $ref parameter that cannot be resolved in the document is added then reports it as breaking', () => {
      const missing = { $ref: './shared.yaml#/components/parameters/Region' };
      const result = diffContract(document([ref('Locale')]), document([ref('Locale'), missing]));
      assert.deepEqual(result.breaking, [`必須parameterを追加: ${at('[$ref:./shared.yaml#/components/parameters/Region]')}`]);
    });
  });

  describe('given an operation that mixes inline and $ref parameters', () => {
    it('when an inline parameter is added next to $ref parameters then neither collides with the other', () => {
      const result = diffContract(document([ref('Locale'), ref('Page')]), document([ref('Locale'), ref('Page'), query('q')]));
      assert.deepEqual(result, { breaking: [], nonBreaking: [`追加: ${at('[query:q]')}`] });
    });
    it('when a required inline parameter is added next to $ref parameters then reports it as breaking', () => {
      const result = diffContract(document([ref('Locale')]), document([ref('Locale'), query('q', true)]));
      assert.deepEqual(result.breaking, [`必須parameterを追加: ${at('[query:q]')}`]);
    });
    it('when an inline parameter is removed while $ref parameters stay then reports only the inline one as breaking', () => {
      const result = diffContract(document([ref('Locale'), query('q')]), document([ref('Locale')]));
      assert.deepEqual(result, { breaking: [`削除: ${at('[query:q]')}`], nonBreaking: [] });
    });
    it('when an inline parameter becomes required then reports the change at its in and name', () => {
      const result = diffContract(document([ref('Locale'), query('q')]), document([ref('Locale'), query('q', true)]));
      assert.ok(result.breaking.some(line => line.includes(at('[query:q].required'))), JSON.stringify(result));
    });
  });
});
