# frozen_string_literal: true

namespace :contract do
  desc "Write config/routes.manifest.json for the api-contract verifier"
  task routes: :environment do
    RouteManifest.write
  end
end
