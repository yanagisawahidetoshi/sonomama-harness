# frozen_string_literal: true

require "rails_helper"

RSpec.describe RouteManifest do
  describe ".entries" do
    context "when Rails draws the health check route" do
      it "lists it with its verb, path, controller and action so api-contract can compare routes with OpenAPI" do
        expect(described_class.entries).to include(
          { "verb" => "GET", "path" => "/up(.:format)", "controller" => "rails/health", "action" => "show" }
        )
      end
    end
  end

  describe "config/routes.manifest.json" do
    context "when the routes change" do
      it "matches the routes Rails draws, so the contract check never reads a stale manifest" do
        expect(JSON.parse(described_class.path.read)).to eq(described_class.entries),
                                                     "Run `bin/rails contract:routes` and commit #{described_class.path}"
      end
    end
  end
end
