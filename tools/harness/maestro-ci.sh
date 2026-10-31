#!/usr/bin/env bash
# Runs the Maestro lanes inside the CI Android Emulator (called by the maestro job in .github/workflows/harness.yml).
# Usage: tools/harness/maestro-ci.sh <apk> <head sha> <lane>...
# mock: Prism serves the approved packages/api-schema/openapi.yaml. real: Rails and the database run from compose.yaml.
# Each lane writes $MAESTRO_CI_OUT/results/<lane>.json (the Completion Judge reads it) and keeps the JUnit report, logs and screenshots
# under $MAESTRO_CI_OUT/evidence/<lane>. CI points MAESTRO_CI_OUT outside the checkout (#188); locally it defaults to .maestro-ci. Any lane that cannot start or fails makes the script exit non-zero; its result file still says why.
set -uo pipefail
apk=$1 head=$2
shift 2
out=${MAESTRO_CI_OUT:-.maestro-ci}
mkdir -p "$out/results" "$out/evidence"
# Absolute, so the Metro log path stays right after cd apps/mobile.
out=$(cd "$out" && pwd)
status=0
adb install -r "$apk" || exit 1

# Ready means the server answers at all (Prism answers an unknown path with 404).
wait_for() { for _ in $(seq 1 "$2"); do [ "$(curl -s -o /dev/null -w '%{http_code}' "$1")" != 000 ] && return 0; sleep 2; done; return 1; }
stop_backend() { [ -n "${backend:-}" ] && kill "$backend" 2>/dev/null; docker compose -f compose.yaml down >/dev/null 2>&1 || true; backend=; }

for lane in "$@"; do
  evidence="$out/evidence/$lane"
  mkdir -p "$evidence"
  started=true
  case "$lane" in
    mock)
      # The mock lane needs the approved Source of Truth; without it nothing can be confirmed.
      if [ -f packages/api-schema/openapi.yaml ]; then
        node node_modules/@stoplight/prism-cli/dist/index.js mock packages/api-schema/openapi.yaml -h 127.0.0.1 -p 4010 > "$evidence/prism.log" 2>&1 &
        backend=$!
        wait_for http://127.0.0.1:4010/ 60 || started=false
      else
        echo "packages/api-schema/openapi.yaml がありません" > "$evidence/prism.log"; started=false
      fi
      api=http://10.0.2.2:4010 ;;
    real)
      # The Compose file is checked by the Harness before it starts, as for the Rails verifiers.
      node -e "import('./tools/harness/isolation.mjs').then(async m => m.validateCompose(process.cwd(), process.cwd() + '/compose.yaml', await (await import('node:fs/promises')).readFile('compose.yaml', 'utf8')))" > "$evidence/compose.log" 2>&1 \
        && docker compose -f compose.yaml up -d --build api >> "$evidence/compose.log" 2>&1 \
        && wait_for http://127.0.0.1:3000/up 150 || started=false
      api=http://10.0.2.2:3000 ;;
    *) echo "unknown lane $lane" > "$evidence/error.log"; started=false; api= ;;
  esac
  if $started; then
    # Metro serves the JavaScript of this commit; the API base URL is read at bundle time, so each lane gets its own Metro.
    (cd apps/mobile && CI=1 EXPO_PUBLIC_API_BASE_URL=$api npx expo start --dev-client --port 8081 > "$evidence/metro.log" 2>&1) &
    metro=$!
    wait_for http://127.0.0.1:8081/status 90 || started=false
  fi
  if $started; then
    maestro test "apps/mobile/.maestro/$lane" --format junit --output "$evidence/report.xml" --test-output-dir "$evidence/debug" > "$evidence/maestro.log" 2>&1 || status=1
  else
    status=1
  fi
  adb exec-out screencap -p > "$evidence/last-screen.png" 2>/dev/null || true
  # A lane that never ran has no report, which the result turns into FAIL with no flow.
  node tools/harness/maestro.mjs --lane "$lane" --junit "$evidence/report.xml" --head "$head" --artifact maestro-evidence --out "$out/results/$lane.json" || status=1
  [ -n "${metro:-}" ] && kill "$metro" 2>/dev/null; metro=
  stop_backend
done
exit $status
