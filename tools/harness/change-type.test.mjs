import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChangeType, describeChangeType } from './change-type.mjs';

// A file as changedFiles reports it: a modified regular file unless the test says otherwise.
const file = (path, extra = {}) => ({ path, status: 'M', mode: '100644', modeChanged: false, binary: false, added: '', deleted: '', ...extra });
const classify = (...files) => classifyChangeType(files.map(f => typeof f === 'string' ? file(f) : f));
const pkg = (dependencies, extra = {}) => JSON.stringify({ name: '@sonomama/admin', private: true, scripts: { build: 'vite build' }, dependencies, ...extra }, null, 2);
const packageChange = (before, after, extra = {}) => file('apps/admin/package.json', { before, after, ...extra });
const gemfile = lines => ['source "https://rubygems.org"', '', ...lines, ''].join('\n');
const gemfileChange = (before, after) => file('apps/api/Gemfile', { before: gemfile(before), after: gemfile(after) });

describe('Change type of a Production diff', () => {
  describe('given a diff without a Production path', () => {
    for (const path of ['docs/architecture/README.md', 'tools/harness/impact.mjs', '.github/workflows/harness.yml', 'prototypes/web/src/main.tsx']) {
      it(`when only ${path} changes then no change type is given and no SBI is required`, () => {
        const result = classify(path);
        assert.equal(result.changeType, null);
        assert.equal(result.requiresSbi, false);
      });
    }
  });

  describe('given Production files that are proven not to enter the runtime', () => {
    for (const [path, rule] of [
      ['apps/admin/README.md', 'markdown'],
      ['apps/api/docs/setup.md', 'markdown'],
      ['packages/api-schema/README.md', 'markdown'],
      ['apps/api/Gemfile.lock', 'lockfile'],
      ['apps/admin/src/shared/ui/Button/Button.stories.tsx', 'storybook-stories'],
      ['apps/admin/.storybook/main.ts', 'storybook-config'],
      ['apps/admin/src/features/home/index.test.tsx', 'tests'],
      ['apps/mobile/src/shared/api/http-client.test.ts', 'tests'],
      ['apps/api/spec/requests/lessons_spec.rb', 'tests'],
      ['apps/mobile/jest.config.js', 'test-config'],
      ['apps/admin/vitest.config.ts', 'test-config'],
      ['apps/api/.rspec', 'test-config'],
      ['apps/admin/biome.json', 'lint-config'],
    ]) {
      it(`when ${path} changes then the diff is engineering by the ${rule} rule and needs no SBI`, () => {
        const result = classify(path);
        assert.equal(result.changeType, 'engineering');
        assert.equal(result.requiresSbi, false);
        assert.deepEqual(result.engineering, [{ path, rule }]);
        assert.deepEqual(result.ambiguous, []);
      });
    }

    it('when a Markdown file is deleted then it stays engineering', () => {
      assert.equal(classify(file('apps/admin/README.md', { status: 'D' })).changeType, 'engineering');
    });
  });

  describe('given Production files that enter the runtime', () => {
    for (const path of [
      'apps/admin/src/features/home/index.tsx',
      'apps/mobile/src/app/index.tsx',
      'apps/api/app/models/lesson.rb',
      'apps/api/config/routes.rb',
      'apps/api/db/schema.rb',
      'apps/api/lib/tasks/seed.rake',
      'packages/api-schema/openapi.yaml',
      'apps/admin/tsconfig.app.json',
      'apps/admin/vite.config.ts',
      'apps/mobile/app.json',
      'apps/admin/index.html',
    ]) {
      it(`when ${path} changes then the diff is ambiguous and requires an SBI`, () => {
        const result = classify(path);
        assert.equal(result.changeType, 'ambiguous');
        assert.equal(result.requiresSbi, true);
        assert.deepEqual(result.ambiguous.map(a => a.path), [path]);
      });
    }

    for (const path of ['apps/admin/src/features/home/README.md', 'apps/api/app/views/lessons/index.md', 'apps/api/config/locales/notes.md', 'apps/admin/public/terms.md']) {
      it(`when the Markdown file ${path} sits where the runtime reads files then it is ambiguous`, () => {
        assert.equal(classify(path).changeType, 'ambiguous');
      });
    }
  });

  describe('given a diff that mixes engineering and runtime files', () => {
    it('when one runtime file changes next to a README then the whole diff is ambiguous and names only the runtime file', () => {
      const result = classify('apps/admin/README.md', 'apps/admin/src/features/home/index.tsx', 'docs/architecture/README.md');
      assert.equal(result.changeType, 'ambiguous');
      assert.equal(result.requiresSbi, true);
      assert.deepEqual(result.ambiguous.map(a => a.path), ['apps/admin/src/features/home/index.tsx']);
      assert.deepEqual(result.engineering.map(e => e.path), ['apps/admin/README.md']);
    });

    it('when a source file is renamed to a Markdown file then the deletion of the source file keeps it ambiguous', () => {
      const result = classify(file('apps/admin/src/features/home/index.tsx', { status: 'D' }), file('apps/admin/README.md', { status: 'A' }));
      assert.equal(result.changeType, 'ambiguous');
    });
  });

  describe('given a file whose path matches an engineering rule but whose kind cannot be proven', () => {
    for (const [name, extra] of [
      ['a symlink', { mode: '120000' }],
      ['a binary file', { binary: true }],
      ['a file whose mode changed', { modeChanged: true }],
    ]) {
      it(`when it is ${name} then it is ambiguous`, () => {
        const result = classify(file('apps/admin/README.md', extra));
        assert.equal(result.changeType, 'ambiguous');
        assert.equal(result.requiresSbi, true);
      });
    }
  });

  describe('given a change to an app package.json', () => {
    const before = pkg({ react: '19.1.0', axios: '^1.7.0' });

    it('when only the versions of existing dependencies change then it is engineering', () => {
      const result = classify(packageChange(before, pkg({ react: '19.1.0', axios: '^1.8.2' })));
      assert.equal(result.changeType, 'engineering');
      assert.deepEqual(result.engineering, [{ path: 'apps/admin/package.json', rule: 'package-json-dependency-versions' }]);
    });

    it('when the versions in devDependencies change then it is engineering', () => {
      const result = classify(packageChange(pkg({}, { devDependencies: { vitest: '^3.0.0' } }), pkg({}, { devDependencies: { vitest: '^3.2.4' } })));
      assert.equal(result.changeType, 'engineering');
    });

    for (const [name, after] of [
      ['a dependency is added', pkg({ react: '19.1.0', axios: '^1.7.0', zod: '^4.0.0' })],
      ['a dependency is removed', pkg({ react: '19.1.0' })],
      ['a script changes', pkg({ react: '19.1.0', axios: '^1.7.0' }, { scripts: { build: 'vite build && node postbuild.mjs' } })],
      ['overrides are added', pkg({ react: '19.1.0', axios: '^1.7.0' }, { pnpm: { overrides: { axios: '1.0.0' } } })],
      ['a new top-level key is added', pkg({ react: '19.1.0', axios: '^1.7.0' }, { 'x-renovate': 'bump' })],
      ['the file is not valid JSON', '{ broken'],
    ]) {
      it(`when ${name} then it is ambiguous`, () => {
        assert.equal(classify(packageChange(before, after)).changeType, 'ambiguous');
      });
    }

    for (const version of ['^1.8.2', '~1.7.9', '1.8.2', '>=1.7.0 <2', '1.x', '^1.7.0 || ^2.0.0', '1.8.0-rc.1', '*']) {
      it(`when a version becomes the semver range ${version} then it is engineering`, () => {
        assert.equal(classify(packageChange(before, pkg({ react: '19.1.0', axios: version }))).changeType, 'engineering');
      });
    }

    for (const [name, spec] of [
      ['an npm alias to another package', 'npm:evil@1.0.0'],
      ['a git URL', 'github:someone/axios'],
      ['a git+https URL', 'git+https://github.com/someone/axios.git'],
      ['a tarball URL', 'https://example.com/axios-1.8.2.tgz'],
      ['a local file', 'file:../axios'],
      ['a link', 'link:../axios'],
      ['a workspace package', 'workspace:*'],
      ['a dist tag', 'latest'],
    ]) {
      it(`when an existing dependency is pointed at ${name} then it is ambiguous because it is no longer a version`, () => {
        assert.equal(classify(packageChange(before, pkg({ react: '19.1.0', axios: spec }))).changeType, 'ambiguous');
      });
    }

    it('when the package.json is added then it is ambiguous', () => {
      assert.equal(classify(packageChange(undefined, before, { status: 'A' })).changeType, 'ambiguous');
    });

    it('when the contents before and after were not read then it fails closed to ambiguous', () => {
      assert.equal(classify('apps/admin/package.json').changeType, 'ambiguous');
    });
  });

  describe('given a change to the API Gemfile', () => {
    it('when only the version of an existing gem changes then it is engineering', () => {
      const result = classify(gemfileChange(['gem "rails", "~> 8.0.2"', 'gem "puma", ">= 5.0"'], ['gem "rails", "~> 8.0.3"', 'gem "puma", ">= 6.0", "< 7"']));
      assert.equal(result.changeType, 'engineering');
      assert.deepEqual(result.engineering, [{ path: 'apps/api/Gemfile', rule: 'gemfile-versions' }]);
    });

    for (const [name, before, after] of [
      ['a gem is added', ['gem "rails", "~> 8.0.2"'], ['gem "rails", "~> 8.0.2"', 'gem "rack-attack"']],
      ['a gem is removed', ['gem "rails", "~> 8.0.2"', 'gem "puma", ">= 5.0"'], ['gem "rails", "~> 8.0.2"']],
      ['a gem is swapped for another', ['gem "puma", ">= 5.0"'], ['gem "falcon", ">= 5.0"']],
      ['an option such as require changes', ['gem "bootsnap", require: false'], ['gem "bootsnap"']],
      ['a group changes', ['gem "rails", "~> 8.0.2"'], ['group :development do', '  gem "rails", "~> 8.0.2"', 'end']],
      ['a line of Ruby changes', ['gem "rails", "~> 8.0.2"'], ['gem "rails", ENV.fetch("RAILS_VERSION")']],
      ['a version string becomes something that is not a requirement', ['gem "rails", "~> 8.0.2"'], ['gem "rails", "#{ENV["RAILS"]}"']],
    ]) {
      it(`when ${name} then it is ambiguous`, () => {
        assert.equal(classify(gemfileChange(before, after)).changeType, 'ambiguous');
      });
    }
  });

  describe('given words in the commit message, the PR body or the branch name', () => {
    it('when the classifier is called then it reads only the changed files, so a refactor or engineering claim cannot change the result', () => {
      const runtime = file('apps/admin/src/features/home/index.tsx', { message: 'refactor: engineering only', body: 'engineering', branch: 'engineering/refactor' });
      assert.equal(classify(runtime).changeType, 'ambiguous');
    });
  });

  describe('given the result is printed for the CI log', () => {
    it('when the diff is engineering then the log says no SBI is required and names the rule of each file', () => {
      const lines = describeChangeType(classify('apps/admin/README.md'));
      assert.equal(lines[0], 'Change type: engineering / SBI not required');
      assert.ok(lines.includes('Change type rule markdown: apps/admin/README.md'), lines.join('\n'));
    });

    it('when the diff is ambiguous then the log keeps it apart from a product judgement and names the file that was not proven', () => {
      const lines = describeChangeType(classify('apps/admin/README.md', 'apps/admin/src/features/home/index.tsx'));
      assert.equal(lines[0], 'Change type: ambiguous / SBI required (fail-closed)');
      assert.ok(lines.some(l => l.startsWith('Change type ambiguous: apps/admin/src/features/home/index.tsx')), lines.join('\n'));
      assert.ok(!lines.some(l => /product/i.test(l)), lines.join('\n'));
    });

    it('when no Production path changed then the log says so', () => {
      assert.deepEqual(describeChangeType(classify('docs/architecture/README.md')), ['Change type: none (no production path changed) / SBI not required']);
    });
  });
});
