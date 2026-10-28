# frozen_string_literal: true

# Routes Rails draws, written to config/routes.manifest.json so the api-contract verifier can compare them with OpenAPI
# without booting Rails. spec/lib/route_manifest_spec.rb fails when the committed manifest is stale.
module RouteManifest
  module_function

  def path
    Rails.root.join("config/routes.manifest.json")
  end

  def entries
    routes = Rails.application.routes.routes.reject(&:internal)
    routes.map { |route| entry(route) }.sort_by { |entry| [entry["path"], entry["verb"]] }
  end

  def entry(route)
    { "verb" => route.verb, "path" => route.path.spec.to_s,
      "controller" => route.defaults[:controller], "action" => route.defaults[:action] }
  end

  def write
    path.write("#{JSON.pretty_generate(entries)}\n")
  end
end
