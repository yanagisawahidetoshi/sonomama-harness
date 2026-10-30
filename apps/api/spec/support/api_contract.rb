# frozen_string_literal: true

require "erb"
require "json"
require "openapi_first"
require "yaml"

# Checks what a request spec really sent and what Rails really returned against the OpenAPI 3.1 contract
# (packages/api-schema/openapi.yaml). openapi_first resolves parameters (path, query, header, cookie) and response
# headers; json_schemer validates JSON bodies without inserting schema defaults, so a missing required property with a
# default still fails. Bodies, statuses and media types the contract does not declare fail instead of passing.
module ApiContract
  class ContractError < StandardError; end
  class CoverageError < StandardError; end

  SCHEMA_FILES = %w[openapi.yaml openapi.yml openapi.json].freeze

  module_function

  def schema_dir
    Pathname(ENV.fetch("API_SCHEMA_DIR") { Rails.root.join("../../packages/api-schema").to_s })
  end

  def default_path
    SCHEMA_FILES.map { |file| schema_dir.join(file) }.find(&:exist?)
  end

  # The SSOT contract. A missing document raises, so a request spec never passes without a contract.
  def default
    path = default_path
    raise ContractError, "#{schema_dir.join('openapi.yaml')} does not exist; no API contract to check" unless path

    (@contracts ||= {})[path.to_s] ||= Contract.load(path)
  end

  def default?(contract)
    path = default_path
    !path.nil? && contract.equal?(@contracts&.[](path.to_s))
  end

  def record(contract, operation)
    coverage_records[operation] |= [RSpec.current_example&.location] if default?(contract)
  end

  def coverage_records
    @coverage_records ||= Hash.new { |records, operation| records[operation] = [] }
  end

  # Fails the suite when a Rails business route has no request spec that checked it against the SSOT contract.
  # Only a full run can tell. The rails Verifier sets API_CONTRACT_COVERAGE=required, so there a filter or pattern that
  # drops specs fails; a developer running some files gets NOT CHECKED.
  def verify_suite_coverage(configuration = RSpec.configuration)
    unless full_suite?(configuration)
      if ENV["API_CONTRACT_COVERAGE"] == "required"
        raise CoverageError,
              "API contract coverage: only part of the suite ran"
      end

      return ["API contract coverage: NOT CHECKED (only part of the suite ran)"]
    end

    coverage = Coverage.new(contract: default_path && default, routes: RouteManifest.entries)
    coverage_records.each { |operation, locations| locations.each { |location| coverage.record(operation, location) } }
    coverage.verify!
  end

  def full_suite?(configuration)
    return false unless configuration.inclusion_filter.empty?

    ran = configuration.files_to_run.map { |file| File.expand_path(file) }
    (Rails.root.glob("spec/**/*_spec.rb").map(&:to_s) - ran).empty?
  end
end

require_relative "api_contract/unsupported"
require_relative "api_contract/contract"
require_relative "api_contract/exchange"
require_relative "api_contract/coverage"
require_relative "api_contract/matchers"

RSpec.configure do |config|
  config.include ApiContract::Matchers, type: :request
  config.after(:suite) { |_| config.reporter.message(ApiContract.verify_suite_coverage.join("\n")) }
end
