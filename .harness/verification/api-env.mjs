import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
// Trusted acceptance for SBI-API-ENV (#21). Reads the worktree only; the rails application verifier runs Docker.
const root = process.argv[2];
const app = join(root, 'apps/api');
const read = path => readFileSync(join(root, path), 'utf8');
const files = (dir, out = []) => {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['tmp', 'log', 'vendor', 'node_modules', '.bundle'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    entry.isDirectory() ? files(path, out) : out.push(path);
  }
  return out;
};
const gemfile = () => read('apps/api/Gemfile');
const lock = () => read('apps/api/Gemfile.lock');
const compose = () => read('compose.yaml');
const gems = () => [...gemfile().matchAll(/^\s*gem\s+["']([^"']+)["']/gm)].map(m => m[1]);
const hasGems = names => { for (const name of names) assert.ok(gems().includes(name), `missing gem ${name}`); };
const forbids = (pattern, label) => { for (const name of gems()) assert.doesNotMatch(name, pattern, `${label}: ${name}`); };
// Top-level service block of compose.yaml, enough to assert keys without a YAML parser.
const service = name => compose().match(new RegExp(`^ {2}${name}:\\n((?: {4,}.*\\n|\\s*\\n)*)`, 'm'))?.[1] ?? '';
const verifierCommands = () => JSON.parse(read('.harness/config/harness.json')).verifiers.find(v => v.id === 'rails').commands.map(c => c.join(' '));
const rubyFiles = dir => files(join(app, dir)).filter(p => p.endsWith('.rb')).map(p => readFileSync(p, 'utf8')).join('\n');
try {
  const scenarios = [
    ['API-AC-1', 'Given apps/api, When reading it, Then a Rails API application exists', () => {
      for (const path of ['config/application.rb', 'config/routes.rb', 'bin/rails', 'Rakefile']) assert.ok(existsSync(join(app, path)), path);
      assert.match(read('apps/api/config/application.rb'), /config\.api_only = true/);
    }],
    ['API-AC-2', 'Given apps/api, When building, Then a Dockerfile exists', () => {
      assert.match(read('apps/api/Dockerfile'), /^FROM\s+(docker\.io\/library\/)?ruby:3\.4\.\d+/m);
    }],
    ['API-AC-3', 'Given root compose.yaml, When listing services, Then api and db exist and api builds from apps/api', () => {
      assert.ok(!existsSync(join(app, 'compose.yaml')) && !existsSync(join(app, 'docker-compose.yml')), 'no Rails-only compose');
      assert.match(service('api'), /build:\s*(\n\s+context:\s*)?\.?\/?apps\/api/);
      assert.match(service('api'), /depends_on:/);
      assert.ok(service('db'), 'db service');
    }],
    ['API-AC-4', 'Given the environment, When reading versions, Then Ruby 3.4, Rails 8.1 and PostgreSQL are pinned', () => {
      assert.match(read('apps/api/.ruby-version'), /^(ruby-)?3\.4\.\d+\s*$/);
      assert.match(lock(), /^ {4}rails \(8\.1\.\d+(\.\d+)?\)$/m);
      assert.match(service('db'), /image:\s*["']?postgres:\d+\.\d+[\w.-]*["']?/);
    }],
    ['API-AC-5', 'Given the app, When connecting to a database, Then the PostgreSQL adapter is used', () => {
      hasGems(['pg']);
      assert.match(read('apps/api/config/database.yml'), /adapter:\s*postgresql/);
    }],
    ['API-AC-6', 'Given a developer machine, When following the README, Then Ruby and PostgreSQL run only in containers', () => {
      const readme = read('apps/api/README.md');
      assert.ok(readme.includes('docker compose'), 'docker compose commands');
      assert.match(service('db'), /image:/);
      assert.doesNotMatch(service('db'), /platform:/);
      assert.doesNotMatch(service('api'), /platform:/);
    }],
    ['API-AC-7', 'Given compose.yaml, When starting api and db, Then the Rails server binds to a host port', () => {
      assert.match(service('api'), /ports:\s*\n\s+-\s*["']?(127\.0\.0\.1:)?\d+:3000["']?/);
      assert.match(service('api'), /(rails|bin\/rails)["',\s]+(server|s)\b[^\n]*0\.0\.0\.0|-b["',\s]+0\.0\.0\.0/);
    }],
    ['API-AC-8', 'Given compose.yaml, When preparing databases, Then development and test DBs use a named volume', () => {
      const db = read('apps/api/config/database.yml');
      assert.match(db, /^development:/m); assert.match(db, /^test:/m);
      assert.match(db, /ENV\.fetch\(["']DATABASE_HOST["']/);
      assert.match(service('db'), /volumes:\s*\n\s+-\s*[\w-]+:\/var\/lib\/postgresql/);
      assert.match(compose(), /^volumes:\s*\n(?: {2}[\w-]+:.*\n?)+/m);
    }],
    ['API-AC-9', 'Given a running container, When reaching it from the host, Then the Rails health endpoint is routed', () => {
      assert.match(read('apps/api/config/routes.rb'), /get\s+["']up["']\s*=>\s*["']rails\/health#show["']/);
    }],
    ['API-AC-10', 'Given Docker, When testing, Then RSpec and FactoryBot run with at least one spec', () => {
      hasGems(['rspec-rails', 'factory_bot_rails']);
      assert.ok(files(join(app, 'spec')).some(p => p.endsWith('_spec.rb')), 'at least one spec');
    }],
    ['API-AC-11', 'Given Docker, When linting, Then RuboCop with Rails and RSpec cops is configured', () => {
      hasGems(['rubocop', 'rubocop-rails', 'rubocop-rspec']);
      assert.match(read('apps/api/.rubocop.yml'), /rubocop-rails/);
      assert.match(read('apps/api/.rubocop.yml'), /rubocop-rspec/);
    }],
    ['API-AC-12', 'Given Docker, When scanning, Then Brakeman is installed', () => hasGems(['brakeman'])],
    ['API-AC-13', 'Given Docker, When auditing, Then bundler-audit is installed', () => hasGems(['bundler-audit'])],
    ['API-AC-14', 'Given Docker, When checking autoload, Then Zeitwerk check is a registered verifier command', () => {
      assert.ok(verifierCommands().some(c => c.includes('zeitwerk:check')));
    }],
    ['API-AC-15', 'Given the app, When configuring CORS, Then rack-cors reads allowed origins from the environment', () => {
      hasGems(['rack-cors']);
      const cors = read('apps/api/config/initializers/cors.rb');
      assert.match(cors, /Rack::Cors/);
      assert.match(cors, /ENV\.fetch\(["']CORS_ALLOWED_ORIGINS["']/);
    }],
    ['API-AC-16', 'Given the Harness, When verifying rails, Then RSpec, RuboCop, Brakeman, Bundler Audit and Zeitwerk run through Docker Compose', () => {
      const commands = verifierCommands();
      for (const tool of ['rspec', 'rubocop', 'brakeman', 'bundler-audit', 'zeitwerk:check']) {
        assert.ok(commands.some(c => c.startsWith('docker compose') && c.includes(tool)), tool);
      }
    }],
    ['API-AC-17', 'Given the Gemfile, When listing gems, Then no auth provider SDK is installed', () => {
      forbids(/cognito|firebase|google-cloud|googleauth|aws-sdk|devise|omniauth|jwt|jwks|doorkeeper|auth0/i, 'Auth provider gem must not be installed');
    }],
    ['API-AC-18', 'Given the app, When reading code, Then no JWT, Cognito or Firebase authentication is implemented', () => {
      assert.doesNotMatch(rubyFiles('app') + rubyFiles('config') + rubyFiles('lib'), /\b(JWT|JWKS|Cognito|cognito_sub|Firebase)\b/);
    }],
    ['API-AC-19', 'Given the Gemfile, When listing gems, Then committee-rails is absent', () => forbids(/^committee/, 'committee must not be installed')],
    ['API-AC-20', 'Given the OpenAPI SSOT, When reading apps/api, Then no copy of the schema exists', () => {
      assert.ok(!files(app).some(p => /openapi\.(ya?ml|json)$/i.test(p)), 'OpenAPI copy');
      assert.ok(read('apps/api/README.md').includes('packages/api-schema/openapi.yaml'));
    }],
    ['API-AC-21', 'Given the app, When listing app code and migrations, Then no business model, controller or endpoint exists', () => {
      const models = files(join(app, 'app/models')).map(p => p.split('/').pop());
      assert.deepEqual(models.filter(name => name !== 'application_record.rb' && name !== '.keep'), []);
      const controllers = files(join(app, 'app/controllers')).map(p => p.split('/').pop());
      assert.deepEqual(controllers.filter(name => name !== 'application_controller.rb' && name !== '.keep'), []);
      assert.ok(!files(join(app, 'db/migrate')).some(p => p.endsWith('.rb')), 'no migrations');
      const routes = read('apps/api/config/routes.rb').split('\n').filter(l => /^\s*(get|post|put|patch|delete|resources?|namespace|scope)\b/.test(l));
      assert.deepEqual(routes.map(l => l.trim()), ['get "up" => "rails/health#show", as: :rails_health_check']);
    }],
    ['API-AC-22', 'Given the README, When onboarding, Then the Docker based development steps are documented', () => {
      const readme = read('apps/api/README.md');
      for (const term of ['Ruby 3.4', 'Rails 8.1', 'PostgreSQL', 'docker compose build api', 'docker compose up api db', 'docker compose up -d db',
        'db:prepare', 'bundle exec rspec', 'bundle exec rubocop', 'bundle exec brakeman', 'bundler-audit', 'bash', 'down -v',
        'packages/api-schema/openapi.yaml', '未決定', 'committee-rails', 'OpenAPI 3.1']) assert.ok(readme.includes(term), term);
      assert.ok(existsSync(join(root, '.env.example')) || existsSync(join(app, '.env.example')), '.env.example');
    }],
  ];
  const acceptance = [];
  for (const [id, name, test] of scenarios) { test(); acceptance.push(id); console.error(`PASS ${id}: ${name}`); }
  console.log(JSON.stringify({ acceptance }));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
