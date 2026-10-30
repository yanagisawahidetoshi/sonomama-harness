# frozen_string_literal: true

require "rails_helper"
require_relative "api_contract_fixture"

# The fixture app runs real Rails controllers through a route set of its own, so the specs exercise the same request
# path as product request specs without adding a test endpoint to config/routes.rb.
RSpec.describe "API contract for request specs", type: :request do
  let(:contract) { ApiContract::Contract.load(ApiContractFixture.contract_path) }
  let(:fixture_app) { ApiContractFixture.app }

  def app = fixture_app

  # Returns the matcher's failure message, or nil when the exchange matched the contract.
  def contract_failure(subject_contract = contract, **)
    matcher = match_api_contract(subject_contract, **)
    matcher.matches?(response) ? nil : matcher.failure_message
  end

  describe "a successful response" do
    context "when Rails returns a body that follows the contract" do
      it "passes, so a conforming request spec stays green" do
        get "/students/s-1"

        expect(response).to match_api_contract(contract)
      end
    end

    context "when the contract says studentId is a string and Rails returns a number" do
      let(:fixture_app) { ApiContractFixture.app(show: :numeric_student_id) }

      it "fails and names the operation, the status and the property" do
        get "/students/s-1"

        expect(contract_failure).to include("GET /students/{studentId}", "200", "/studentId")
      end
    end

    context "when a required property is missing" do
      let(:fixture_app) { ApiContractFixture.app(show: :missing_name) }

      it "fails on the missing property" do
        get "/students/s-1"

        expect(contract_failure).to include("name")
      end
    end

    context "when a required property that has a default is missing" do
      let(:fixture_app) { ApiContractFixture.app(show: :missing_defaulted_status) }

      it "fails, because a schema default must not fill in what Rails did not send" do
        get "/students/s-1"

        expect(contract_failure).to include("status")
      end
    end

    context "when a non-nullable property is null" do
      let(:fixture_app) { ApiContractFixture.app(show: :null_name) }

      it "fails on that property" do
        get "/students/s-1"

        expect(contract_failure).to include("/name")
      end
    end

    context "when a nullable property is null" do
      it "passes, because the contract allows null there", :aggregate_failures do
        get "/students/s-1"

        expect(response.parsed_body).to include("nickname" => nil)
        expect(response).to match_api_contract(contract)
      end
    end

    context "when a value is outside the enum" do
      let(:fixture_app) { ApiContractFixture.app(show: :invalid_status) }

      it "fails on the enum property" do
        get "/students/s-1"

        expect(contract_failure).to include("/status")
      end
    end

    context "when an array element has the wrong type" do
      let(:fixture_app) { ApiContractFixture.app(show: :numeric_tag) }

      it "fails on that element" do
        get "/students/s-1"

        expect(contract_failure).to include("/tags/1")
      end
    end

    context "when a nested object misses a required property" do
      let(:fixture_app) { ApiContractFixture.app(show: :missing_nested_grade) }

      it "fails on the nested object" do
        get "/students/s-1"

        expect(contract_failure).to include("/profile", "grade")
      end
    end

    context "when the schema allows additional properties and Rails adds one" do
      let(:fixture_app) { ApiContractFixture.app(show: :extra_property) }

      it "passes, because the contract does not forbid it" do
        get "/students/s-1"

        expect(response).to match_api_contract(contract)
      end
    end

    context "when the schema forbids additional properties and Rails adds one" do
      let(:fixture_app) { ApiContractFixture.app(index: :index_with_extra_property) }

      it "fails on the forbidden property" do
        get "/students"

        expect(contract_failure).to include("GET /students", "total")
      end
    end

    context "when the status is not declared for the operation" do
      let(:fixture_app) { ApiContractFixture.app(show: :undeclared_status) }

      it "fails and names the status" do
        get "/students/s-1"

        expect(contract_failure).to include("GET /students/{studentId}", "409")
      end
    end

    context "when the media type is not declared for the status" do
      let(:fixture_app) { ApiContractFixture.app(show: :plain_text) }

      it "fails and names the media type" do
        get "/students/s-1"

        expect(contract_failure).to include("text/plain")
      end
    end
  end

  describe "a response header" do
    context "when the contract requires a header and Rails does not send it" do
      let(:fixture_app) { ApiContractFixture.app(create: :create_without_location) }

      it "fails and names the header" do
        post "/students", params: { name: "Taro", grade: 3 }, as: :json

        expect(contract_failure).to include("POST /students", "201", "Location")
      end
    end
  end

  describe "a response without a body" do
    context "when Rails answers 204 to a DELETE whose contract declares 204 without content" do
      it "passes", :aggregate_failures do
        delete "/students/s-1"

        expect(response).to have_http_status(:no_content)
        expect(response).to match_api_contract(contract)
      end
    end

    context "when the contract declares no content but Rails returns a body" do
      let(:fixture_app) { ApiContractFixture.app(archive: :archive_with_body) }

      it "fails, because the contract has no body for that status" do
        post "/students/s-1/archive"

        expect(contract_failure).to include("POST /students/{studentId}/archive", "202")
      end
    end

    context "when the contract declares no content and Rails returns none" do
      it "passes" do
        post "/students/s-1/archive"

        expect(response).to match_api_contract(contract)
      end
    end
  end

  describe "a declared error response" do
    context "when Rails returns 404 with the declared error body" do
      let(:fixture_app) { ApiContractFixture.app(show: :not_found) }

      it "passes" do
        get "/students/missing"

        expect(response).to match_api_contract(contract)
      end
    end

    context "when Rails returns 404 with a body the contract does not describe" do
      let(:fixture_app) { ApiContractFixture.app(show: :malformed_not_found) }

      it "fails and names the operation and status" do
        get "/students/missing"

        expect(contract_failure).to include("GET /students/{studentId}", "404")
      end
    end
  end

  describe "the request" do
    context "when the request body follows the contract" do
      it "passes for the request and the 201 response", :aggregate_failures do
        post "/students", params: { name: "Taro", grade: 3 }, as: :json

        expect(response).to have_http_status(:created)
        expect(response).to match_api_contract(contract)
      end
    end

    context "when a spec sends an invalid body without declaring it" do
      it "fails, because every request spec must send a conforming request by default" do
        post "/students", params: { name: "Taro", grade: "third" }, as: :json

        expect(contract_failure).to include("POST /students", "request", "/grade")
      end
    end

    context "when a negative spec declares the invalid request and Rails answers with the declared 400" do
      it "passes, because the violation was detected and the error response follows the contract",
         :aggregate_failures do
        post "/students", params: { name: "Taro", grade: "third" }, as: :json

        expect(response).to have_http_status(:bad_request)
        expect(response).to match_api_contract(contract, request: :invalid)
      end
    end

    context "when a negative spec declares an invalid request but the request conforms" do
      it "fails, because the spec did not send the violation it describes" do
        post "/students", params: { name: "Taro", grade: 3 }, as: :json

        expect(contract_failure(request: :invalid)).to include("POST /students", "request")
      end
    end

    context "when a negative spec sends an invalid request and Rails answers with an undocumented error body" do
      let(:fixture_app) { ApiContractFixture.app(create: :create_with_malformed_error) }

      it "fails on the error response" do
        post "/students", params: { name: "Taro", grade: "third" }, as: :json

        expect(contract_failure(request: :invalid)).to include("POST /students", "400")
      end
    end

    context "when the required request body is missing" do
      it "detects the request violation", :aggregate_failures do
        post "/students"

        expect(contract_failure).to include("POST /students", "request")
        expect(response).to match_api_contract(contract, request: :invalid)
      end
    end

    context "when a query parameter breaks its schema" do
      it "detects the request violation on that parameter", :aggregate_failures do
        get "/students", params: { grade: 0 }

        expect(contract_failure).to include("GET /students", "grade")
        expect(response).to match_api_contract(contract, request: :invalid)
      end
    end

    context "when a body is sent to an operation that declares no request body" do
      it "detects the request violation" do
        post "/students/s-1/archive", params: { reason: "moved" }, as: :json

        expect(contract_failure).to include("POST /students/{studentId}/archive", "request body")
      end
    end

    context "when the request has no operation in the contract" do
      let(:fixture_app) do
        ActionDispatch::Routing::RouteSet.new.tap do |routes|
          routes.draw { get "/teachers/:id", to: "api_contract_fixture/students#show" }
        end
      end

      it "fails even for a negative spec, because the operation cannot be resolved", :aggregate_failures do
        get "/teachers/t-1"

        expect(contract_failure).to include("GET /teachers/t-1")
        expect(contract_failure(request: :invalid)).to include("GET /teachers/t-1")
      end
    end
  end

  describe "a contract change" do
    context "when the contract changes studentId to an integer and Rails still returns a string" do
      it "fails the request spec that passed against the previous contract", :aggregate_failures do
        get "/students/s-1"

        changed = ApiContract::Contract.load(ApiContractFixture.contract_path("students_changed"))
        expect(response).to match_api_contract(contract)
        expect(contract_failure(changed)).to include("GET /students/{studentId}", "/studentId")
      end
    end
  end

  describe "the failure message" do
    let(:fixture_app) { ApiContractFixture.app(show: :invalid_guardian_email) }

    context "when the response carries PII and the request carries a token" do
      it "names the property without printing the token, the value or the body", :aggregate_failures do
        opaque = "fixture-#{SecureRandom.hex(8)}"
        get "/students/s-1", headers: { "HTTP_AUTHORIZATION" => "Bearer #{opaque}" }

        message = contract_failure
        expect(message).to include("/guardianEmail")
        expect(message).not_to include(opaque, "guardian-at-example", "Taro")
      end
    end
  end

  describe "the suite coverage of the SSOT contract" do
    let(:show_route) do
      { "verb" => "GET", "path" => "/students/:id(.:format)", "controller" => "students", "action" => "show" }
    end
    let(:create_route) do
      { "verb" => "POST", "path" => "/students(.:format)", "controller" => "students", "action" => "create" }
    end

    # The fixture contract stands in for packages/api-schema/openapi.yaml; the records of this example are discarded.
    around do |example|
      Dir.mktmpdir do |dir|
        FileUtils.cp(ApiContractFixture.contract_path, File.join(dir, "openapi.yaml"))
        previous_dir = ENV.fetch("API_SCHEMA_DIR", nil)
        previous_records = ApiContract.instance_variable_get(:@coverage_records)
        ENV["API_SCHEMA_DIR"] = dir
        ApiContract.instance_variable_set(:@coverage_records, nil)
        example.run
      ensure
        ENV["API_SCHEMA_DIR"] = previous_dir
        ApiContract.instance_variable_set(:@coverage_records, previous_records)
      end
    end

    # What the full suite reports for these Rails routes after this example's matcher runs.
    def suite_coverage(*routes)
      coverage = ApiContract::Coverage.new(contract: ApiContract.default, routes:)
      ApiContract.coverage_records.each do |operation, locations|
        locations.each { |location| coverage.record(operation, location) }
      end
      coverage
    end

    context "when a request spec checks a conforming exchange" do
      it "reports the route as COVERED", :aggregate_failures do
        get "/students/s-1"
        expect(response).to match_api_contract

        expect(suite_coverage(show_route).verify!)
          .to include(a_string_starting_with("COVERED GET /students/{studentId}"))
      end
    end

    context "when the only spec for a route asserts that the exchange does not match the contract" do
      let(:fixture_app) { ApiContractFixture.app(show: :numeric_student_id) }

      it "keeps the route UNCOVERED, because a failed check is not a contract check of the route",
         :aggregate_failures do
        get "/students/s-1"
        expect(response).not_to match_api_contract

        expect { suite_coverage(show_route).verify! }
          .to raise_error(ApiContract::CoverageError, %r{UNCOVERED GET /students/\{studentId\}})
      end
    end

    context "when a negative spec with request: :invalid detects the violation and Rails returns the declared error" do
      it "reports the route as COVERED, because the operation was resolved and its error response follows the contract",
         :aggregate_failures do
        post "/students", params: { name: "Taro", grade: "third" }, as: :json
        expect(response).to match_api_contract(request: :invalid)

        expect(suite_coverage(create_route).verify!).to include(a_string_starting_with("COVERED POST /students"))
      end
    end

    context "when a negative spec with request: :invalid gets an error response the contract does not describe" do
      let(:fixture_app) { ApiContractFixture.app(create: :create_with_malformed_error) }

      it "fails the matcher and keeps the route UNCOVERED", :aggregate_failures do
        post "/students", params: { name: "Taro", grade: "third" }, as: :json
        expect(response).not_to match_api_contract(request: :invalid)

        expect { suite_coverage(create_route).verify! }
          .to raise_error(ApiContract::CoverageError, %r{UNCOVERED POST /students})
      end
    end

    context "when a spec declares request: :invalid but sends a conforming request" do
      it "fails the matcher and keeps the route UNCOVERED", :aggregate_failures do
        post "/students", params: { name: "Taro", grade: 3 }, as: :json
        expect(response).not_to match_api_contract(request: :invalid)

        expect { suite_coverage(create_route).verify! }
          .to raise_error(ApiContract::CoverageError, %r{UNCOVERED POST /students})
      end
    end
  end

  describe "loading a contract" do
    context "when the file does not exist" do
      it "fails with the path, so a missing OpenAPI never counts as a passing check" do
        missing = ApiContractFixture.contract_path("missing")

        expect { ApiContract::Contract.load(missing) }.to raise_error(ApiContract::ContractError, /missing\.yaml/)
      end
    end

    context "when the document is OpenAPI 3.0" do
      it "fails, because the SSOT is OpenAPI 3.1" do
        expect { ApiContract::Contract.load(ApiContractFixture.contract_path("openapi_30")) }
          .to raise_error(ApiContract::ContractError, /3\.1/)
      end
    end

    context "when the contract uses features the adapter cannot validate" do
      it "fails and lists each unsupported feature instead of passing silently" do
        expect { ApiContract::Contract.load(ApiContractFixture.contract_path("unsupported")) }
          .to raise_error(ApiContract::ContractError, %r{report-code.*application/xml.*errors\.yaml}m)
      end
    end

    context "when packages/api-schema has no OpenAPI document" do
      around do |example|
        Dir.mktmpdir do |dir|
          previous = ENV.fetch("API_SCHEMA_DIR", nil)
          ENV["API_SCHEMA_DIR"] = dir
          example.run
        ensure
          ENV["API_SCHEMA_DIR"] = previous
        end
      end

      it "fails the default contract check instead of skipping it", :aggregate_failures do
        get "/students/s-1"

        expect { expect(response).to match_api_contract }
          .to raise_error(ApiContract::ContractError, /openapi\.yaml/)
      end
    end
  end
end
