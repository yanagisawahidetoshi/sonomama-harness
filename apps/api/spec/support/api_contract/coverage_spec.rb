# frozen_string_literal: true

require "rails_helper"
require_relative "../api_contract_fixture"

RSpec.describe ApiContract::Coverage do
  let(:contract) { ApiContract::Contract.load(ApiContractFixture.contract_path) }
  let(:spec_location) { "./spec/requests/students_spec.rb:10" }
  let(:show_route) do
    { "verb" => "GET", "path" => "/students/:id(.:format)", "controller" => "students", "action" => "show" }
  end
  let(:health_route) do
    { "verb" => "GET", "path" => "/up(.:format)", "controller" => "rails/health", "action" => "show" }
  end

  describe "#verify!" do
    context "when every Rails business route has a request spec that checked its operation" do
      it "passes and lists which spec covered which operation, and the operations Rails has not implemented" do
        coverage = described_class.new(contract:, routes: [show_route, health_route])
        coverage.record("GET /students/{studentId}", spec_location)

        expect(coverage.verify!).to include("COVERED GET /students/{studentId} (students#show) by #{spec_location}",
                                            "UNIMPLEMENTED POST /students")
      end
    end

    context "when a Rails business route has no request spec that checked it against the contract" do
      it "fails and names the route" do
        coverage = described_class.new(contract:, routes: [show_route])

        expect { coverage.verify! }
          .to raise_error(ApiContract::CoverageError, %r{UNCOVERED GET /students/\{studentId\} \(students#show\)})
      end
    end

    context "when a Rails business route is not in the contract" do
      it "fails and names the route" do
        route = { "verb" => "GET", "path" => "/teachers(.:format)", "controller" => "teachers", "action" => "index" }
        coverage = described_class.new(contract:, routes: [route])

        expect { coverage.verify! }.to raise_error(ApiContract::CoverageError, %r{UNDEFINED GET /teachers})
      end
    end

    context "when Rails has business routes but packages/api-schema has no OpenAPI document" do
      it "fails, because there is nothing to check the routes against" do
        coverage = described_class.new(contract: nil, routes: [show_route])

        expect { coverage.verify! }.to raise_error(ApiContract::CoverageError, /openapi\.yaml.*students#show/)
      end
    end

    context "when there is no OpenAPI document and Rails only draws framework routes" do
      it "reports that nothing was checked instead of reporting a pass" do
        coverage = described_class.new(contract: nil, routes: [health_route])

        expect(coverage.verify!).to contain_exactly(a_string_including("NOT CHECKED", "openapi.yaml"))
      end
    end
  end
end
